'use strict';
const db = require('../db');
const h = require('../helpers');

function cleanEnvVal(val) {
  if (!val) return '';
  return String(val)
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/[\r\n\s]+$/, '')
    .trim();
}

const getClientId = () => cleanEnvVal(process.env.GOOGLE_CLIENT_ID);
const getClientSecret = () => cleanEnvVal(process.env.GOOGLE_CLIENT_SECRET);

const getRedirectUri = (req = null, explicitPath = null) => {
  // 0. Pinned application origin — trusted, not derived from request headers
  //    (Host / X-Forwarded-Host are attacker-controlled). Set APP_ORIGIN in prod.
  const appOrigin = String(process.env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
  if (appOrigin && !process.env.GOOGLE_REDIRECT_URI) {
    return `${appOrigin}${explicitPath || '/api/auth/callback/google'}`;
  }

  // 1. Explicit environment variable override (if not a stale localhost entry for a remote request)
  if (process.env.GOOGLE_REDIRECT_URI) {
    const raw = cleanEnvVal(process.env.GOOGLE_REDIRECT_URI).replace(/\/+$/, '');
    const isLocalUri = raw.includes('localhost') || raw.includes('127.0.0.1');
    const reqHost = req && req.headers ? (req.headers['x-forwarded-host'] || req.headers.host || '') : '';
    const reqIsRemote = reqHost && !reqHost.includes('localhost') && !reqHost.includes('127.0.0.1');

    if (!isLocalUri || !reqIsRemote) {
      return raw;
    }
  }

  // 2. Derive dynamically from current request host & protocol (ideal for production / custom domains)
  if (req) {
    const proto = (req.headers && req.headers['x-forwarded-proto']
      ? req.headers['x-forwarded-proto'].split(',')[0].trim()
      : (req.connection && req.connection.encrypted ? 'https' : (req.protocol || 'https')));
    const host = (req.headers && req.headers['x-forwarded-host']
      ? req.headers['x-forwarded-host'].split(',')[0].trim()
      : (req.headers && req.headers.host ? req.headers.host : ''));
    if (host) {
      const path = explicitPath || '/api/auth/callback/google';
      return `${proto}://${host}${path}`;
    }
  }

  // 3. Vercel deployment / production domain fallback
  const vercelHost = cleanEnvVal(process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL)
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (vercelHost) {
    return `https://${vercelHost}/api/auth/callback/google`;
  }

  // 4. Local development default
  return 'http://localhost:3000/api/auth/callback/google';
};

// All interview times are stored as wall-clock IST; pin the offset so Google
// receives the same instant regardless of where the server runs.
const IST_OFFSET = '+05:30';

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/calendar.events',
];

function isConfigured() {
  return !!(getClientId() && getClientSecret());
}

function getAuthUrl(state = '', redirectUri = null) {
  const rUri = redirectUri || getRedirectUri();
  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: rUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  if (state) params.set('state', state);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCode(code, redirectUri = null) {
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const rUri = redirectUri || getRedirectUri();

  let tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: rUri,
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
        redirect_uri: rUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    tokenData = await tokenRes.json();
  }

  if (!tokenRes.ok || tokenData.error) {
    console.error('Google token exchange error details:', tokenData);
    let errMsg = tokenData.error_description || tokenData.error || 'Failed to exchange Google OAuth code.';
    if (tokenData.error === 'redirect_uri_mismatch') {
      errMsg = `Google OAuth redirect_uri_mismatch: Google rejected "${rUri}". Add this exact URL to "Authorized redirect URIs" in your Google Cloud Console OAuth Client settings.`;
    }
    throw new Error(errMsg);
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
  const user = db.prepare('SELECT id, google_access_token, google_refresh_token, google_token_expiry FROM users WHERE id=?').get(userId);
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

  const startIso = `${slot.slot_date}T${slot.start_time}:00${IST_OFFSET}`;
  const endIso = `${slot.slot_date}T${slot.end_time}:00${IST_OFFSET}`;

  const eventPayload = {
    summary,
    description,
    location: slot.location || slot.mode,
    start: { dateTime: new Date(startIso).toISOString(), timeZone: 'Asia/Kolkata' },
    end: { dateTime: new Date(endIso).toISOString(), timeZone: 'Asia/Kolkata' },
    attendees: [
      { email: student.email, displayName: student.name },
      { email: mentor.email, displayName: mentor.name },
    ],
    conferenceData: {
      createRequest: {
        requestId: `konfident-${slot.id || interviewId || 'iv'}-${Date.now()}`,
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
      const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all', {
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
      if (meetUrl && slot.id) {
        db.prepare("UPDATE slots SET location=? WHERE id=?").run(meetUrl, slot.id);
      }
    } catch (_) {}
  }

  return createdEventId;
}

async function createSlotCalendarEvent({ mentor, slot }) {
  if (!mentor || !slot) return null;
  if (!mentor.google_calendar_enabled) return null;

  const token = await getValidAccessToken(mentor.id);
  if (!token) return null;

  const summary = `Konfident: Available ${h.titleCase(slot.type)} Slot`;
  const description = `Open mock interview slot scheduled on Konfident platform.\nType: ${h.titleCase(slot.type)}\nMode: ${slot.mode}`;
  const startIso = `${slot.slot_date}T${slot.start_time}:00${IST_OFFSET}`;
  const endIso = `${slot.slot_date}T${slot.end_time}:00${IST_OFFSET}`;

  const eventPayload = {
    summary,
    description,
    location: slot.location || 'Google Meet',
    start: { dateTime: new Date(startIso).toISOString(), timeZone: 'Asia/Kolkata' },
    end: { dateTime: new Date(endIso).toISOString(), timeZone: 'Asia/Kolkata' },
    conferenceData: {
      createRequest: {
        requestId: `konfident-slot-${slot.id}-${Date.now()}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
  };

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
    if (res.ok && data.id) {
      const meetUrl = data.hangoutLink || (data.conferenceData && data.conferenceData.entryPoints && data.conferenceData.entryPoints[0] ? data.conferenceData.entryPoints[0].uri : null);
      if (meetUrl) {
        db.prepare('UPDATE slots SET google_event_id=?, location=? WHERE id=?').run(data.id, meetUrl, slot.id);
      } else {
        db.prepare('UPDATE slots SET google_event_id=? WHERE id=?').run(data.id, slot.id);
      }
      return { eventId: data.id, meetUrl };
    }
  } catch (err) {
    console.error(`Error creating calendar event for slot ${slot.id}:`, err);
  }
  return null;
}

async function updateCalendarEvent({ eventId, student, mentor, slot }) {
  if (!eventId || !slot) return;

  const startIso = `${slot.slot_date}T${slot.start_time}:00${IST_OFFSET}`;
  const endIso = `${slot.slot_date}T${slot.end_time}:00${IST_OFFSET}`;

  const patchPayload = {
    summary: `Konfident 2025: ${h.titleCase(slot.type)} Mock Interview`,
    location: slot.location || slot.mode,
    start: { dateTime: new Date(startIso).toISOString(), timeZone: 'Asia/Kolkata' },
    end: { dateTime: new Date(endIso).toISOString(), timeZone: 'Asia/Kolkata' },
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

async function syncUpcomingMentorSlots(mentor) {
  if (!mentor || !mentor.id) return;
  const token = await getValidAccessToken(mentor.id);
  if (!token) return;

  const now = h.nowMinute();

  // 1. Sync upcoming booked interviews where Google Meet is pending
  try {
    const bookedInterviews = db.prepare(`
      SELECT i.id AS interview_id, i.google_event_id AS interview_google_event_id,
             s.id AS slot_id, s.slot_date, s.start_time, s.end_time, s.type, s.mode, s.location, s.google_event_id AS slot_google_event_id,
             st.id AS student_id, st.name AS student_name, st.email AS student_email,
             st.google_calendar_enabled AS student_cal_enabled
        FROM interviews i
        JOIN slots s ON s.id = i.slot_id
        JOIN users st ON st.id = i.student_id
       WHERE i.mentor_id = ? AND i.status = 'booked'
         AND (s.slot_date || ' ' || s.start_time) > ?
    `).all(mentor.id, now);

    for (const iv of bookedInterviews) {
      if (!iv.interview_google_event_id) {
        const studentObj = {
          id: iv.student_id,
          name: iv.student_name,
          email: iv.student_email,
          google_calendar_enabled: iv.student_cal_enabled,
        };
        const slotObj = {
          id: iv.slot_id,
          slot_date: iv.slot_date,
          start_time: iv.start_time,
          end_time: iv.end_time,
          type: iv.type,
          mode: iv.mode,
          location: iv.location,
        };
        await syncCalendarEvent({
          student: studentObj,
          mentor,
          slot: slotObj,
          interviewId: iv.interview_id,
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('Error syncing booked interviews for mentor:', err && err.message);
  }

  // 2. Sync upcoming open slots created on mentor's behalf that don't have real Google Meet links yet
  try {
    const openSlots = db.prepare(`
      SELECT * FROM slots
       WHERE mentor_id = ? AND status = 'open' AND google_event_id IS NULL
         AND (slot_date || ' ' || start_time) > ?
    `).all(mentor.id, now);

    for (const slot of openSlots) {
      await createSlotCalendarEvent({ mentor, slot }).catch(() => {});
    }
  } catch (err) {
    console.error('Error syncing open slots for mentor:', err && err.message);
  }
}

module.exports = {
  isConfigured,
  getAuthUrl,
  exchangeCode,
  getValidAccessToken,
  syncCalendarEvent,
  createSlotCalendarEvent,
  syncUpcomingMentorSlots,
  updateCalendarEvent,
  removeCalendarEvent,
  getRedirectUri,
  cleanEnvVal,
  getClientId,
};
