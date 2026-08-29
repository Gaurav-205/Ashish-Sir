'use strict';
const db = require('../db');
const h = require('../helpers');

const getClientId = () => (process.env.GOOGLE_CLIENT_ID || '').replace(/[\r\n\s]+$/, '').trim();
const getClientSecret = () => (process.env.GOOGLE_CLIENT_SECRET || '').replace(/[\r\n\s]+$/, '').trim();
const getRedirectUri = () => {
  if (process.env.GOOGLE_REDIRECT_URI) {
    return process.env.GOOGLE_REDIRECT_URI.replace(/[\r\n\s]+$/, '').trim();
  }
  if (process.env.VERCEL_URL) {
    const host = process.env.VERCEL_URL.replace(/^https?:\/\//, '').replace(/[\r\n\s]+$/, '').trim();
    return `https://${host}/api/auth/callback/google`;
  }
  return 'http://localhost:3000/api/auth/callback/google';
};

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/calendar.events',
];

function isConfigured() {
  return !!(getClientId() && getClientSecret());
}

function getAuthUrl(state = '') {
  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  if (state) params.set('state', state);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCode(code) {
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const redirectUri = getRedirectUri();

  let tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });

  let tokenData = await tokenRes.json();

  if (!tokenRes.ok && tokenData.error === 'invalid_client') {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basic}`,
      },
      body: new URLSearchParams({
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    tokenData = await tokenRes.json();
  }

  if (!tokenRes.ok || tokenData.error) {
    console.error('Google token exchange error details:', tokenData);
    throw new Error(tokenData.error_description || tokenData.error || 'Failed to exchange Google OAuth code.');
  }

  const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const profile = await userInfoRes.json();
  if (!userInfoRes.ok) {
    throw new Error('Failed to fetch user profile from Google.');
  }

  return {
    tokens: {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || null,
      expires_in: tokenData.expires_in || 3600,
      expiry_date: Date.now() + ((tokenData.expires_in || 3600) * 1000),
    },
    profile: {
      id: profile.sub,
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
    },
  };
}

async function getValidAccessToken(userId) {
  const user = db.prepare('SELECT google_access_token, google_refresh_token, google_token_expiry FROM users WHERE id=?').get(userId);
  if (!user || !user.google_access_token) return null;

  // Check if token is still valid (buffer of 60 seconds)
  if (user.google_token_expiry && user.google_token_expiry > Date.now() + 60000) {
    return user.google_access_token;
  }

  if (!user.google_refresh_token) {
    return user.google_access_token;
  }

  // Refresh access token
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: getClientId(),
        client_secret: getClientSecret(),
        refresh_token: user.google_refresh_token,
        grant_type: 'refresh_token',
      }).toString(),
    });

    const data = await res.json();
    if (!res.ok || data.error) return null;

    const newExpiry = Date.now() + ((data.expires_in || 3600) * 1000);
    db.prepare('UPDATE users SET google_access_token=?, google_token_expiry=? WHERE id=?')
      .run(data.access_token, newExpiry, user.id);

    return data.access_token;
  } catch (e) {
    console.error('Error refreshing Google access token:', e);
    return null;
  }
}

async function syncCalendarEvent({ student, mentor, slot, interviewId }) {
  if (!student || !mentor || !slot) return null;

  const summary = `Konfident 2025: ${h.titleCase(slot.type)} Mock Interview`;
  const description = `Mock Interview Session\nStudent: ${student.name} (${student.email})\nMentor: ${mentor.name} (${mentor.email})\nType: ${h.titleCase(slot.type)}\nMode: ${slot.mode}${slot.location ? `\nLocation/Meeting Link: ${slot.location}` : ''}`;

  const startIso = `${slot.slot_date}T${slot.start_time}:00`;
  const endIso = `${slot.slot_date}T${slot.end_time}:00`;

  const eventPayload = {
    summary,
    description,
    location: slot.location || slot.mode,
    start: { dateTime: new Date(startIso).toISOString() },
    end: { dateTime: new Date(endIso).toISOString() },
    attendees: [
      { email: student.email, displayName: student.name },
      { email: mentor.email, displayName: mentor.name },
    ],
    conferenceData: {
      createRequest: {
        requestId: `konfident-${slot.id}-${Date.now()}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
  };

  // Attempt sync for student and mentor
  let createdEventId = null;
  let meetUrl = null;

  for (const person of [student, mentor]) {
    if (!person.google_calendar_enabled) continue;
    const token = await getValidAccessToken(person.id);
    if (!token) continue;

    try {
      const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventPayload),
      });
      const data = await res.json();
      if (res.ok && data.id && !createdEventId) {
        createdEventId = data.id;
        meetUrl = data.hangoutLink || (data.conferenceData && data.conferenceData.entryPoints && data.conferenceData.entryPoints[0] ? data.conferenceData.entryPoints[0].uri : null);
      }
    } catch (err) {
      console.error(`Error adding calendar event for user ${person.id}:`, err);
    }
  }

  if (createdEventId && interviewId) {
    try {
      db.prepare('UPDATE interviews SET google_event_id=? WHERE id=?').run(createdEventId, interviewId);
      if (meetUrl) {
        db.prepare("UPDATE slots SET location=? WHERE id=? AND (location IS NULL OR location = '' OR location LIKE 'Online%')").run(meetUrl, slot.id);
      }
    } catch (_) {}
  }

  return createdEventId;
}

async function updateCalendarEvent({ eventId, student, mentor, slot }) {
  if (!eventId || !slot) return;

  const startIso = `${slot.slot_date}T${slot.start_time}:00`;
  const endIso = `${slot.slot_date}T${slot.end_time}:00`;

  const patchPayload = {
    summary: `Konfident 2025: ${h.titleCase(slot.type)} Mock Interview`,
    location: slot.location || slot.mode,
    start: { dateTime: new Date(startIso).toISOString() },
    end: { dateTime: new Date(endIso).toISOString() },
  };

  for (const person of [student, mentor].filter(Boolean)) {
    const token = await getValidAccessToken(person.id);
    if (!token) continue;

    try {
      await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patchPayload),
      });
    } catch (err) {
      console.error('Error patching calendar event:', err);
    }
  }
}

async function removeCalendarEvent({ eventId, student, mentor }) {
  if (!eventId) return;

  for (const person of [student, mentor].filter(Boolean)) {
    const token = await getValidAccessToken(person.id);
    if (!token) continue;

    try {
      await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      console.error('Error removing calendar event:', err);
    }
  }
}

module.exports = {
  isConfigured,
  getAuthUrl,
  exchangeCode,
  getValidAccessToken,
  syncCalendarEvent,
  updateCalendarEvent,
  removeCalendarEvent,
};
