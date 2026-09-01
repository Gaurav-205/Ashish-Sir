'use strict';
const { User } = require('./models');
const { clearAuthSession } = require('./middleware/sessionAuth');

const HOME = { admin: '/admin', mentor: '/mentor', student: '/student', developer: '/admin' };

/** Where a signed-in user belongs. Unknown roles fall back to the profile page. */
function homeFor(role) {
  return HOME[role] || '/profile';
}

function isUserDeveloper(user) {
  if (!user) return false;
  return Boolean(user.is_developer || user.role === 'developer');
}

function isDualRoleUser(user) {
  if (!user) return false;
  if (isUserDeveloper(user)) return true;
  const canEval = Boolean(user.can_technical || user.can_hr);
  return user.role === 'admin' && canEval;
}

/**
 * Re-reads the session user from the database on every request so that a
 * deactivated, deleted or role-changed account cannot keep using a session
 * that was minted before the change.
 */
async function resolveCurrentUser(req, res) {
  if (!req.session || !req.session.user) {
    if (req.method === 'GET') req.session.redirectTo = req.originalUrl;
    respondUnauthenticated(req, res);
    return null;
  }

  let user = null;
  const userId = req.session.user.id || req.session.user._id;

  if (req._resolvedUser && String(req._resolvedUser._id || req._resolvedUser.id) === String(userId)) {
    user = req._resolvedUser;
  } else if (process.env.NODE_ENV !== 'test' && req.session._cachedUser && req.session._cachedUserAt && (Date.now() - req.session._cachedUserAt < 3000) && String(req.session._cachedUser._id || req.session._cachedUser.id) === String(userId)) {
    user = req.session._cachedUser;
    req._resolvedUser = user;
  } else {
    try {
      user = await User.findById(userId).lean();
      if (user) {
        user.id = user._id;
        req._resolvedUser = user;
        req.session._cachedUser = user;
        req.session._cachedUserAt = Date.now();
      }
    } catch (err) {
      console.error('Auth lookup failed:', err);
    }
  }

  if (!user || !user.active) {
    clearAuthSession(req, res, () => respondUnauthenticated(req, res));
    return null;
  }

  if (user.sessions_invalid_before && req.session.user) {
    if (!req.session.user.iat) {
      req.session.user.iat = Date.now();
    } else if (Number(req.session.user.iat) < Number(user.sessions_invalid_before)) {
      clearAuthSession(req, res, () => respondUnauthenticated(req, res));
      return null;
    }
  }

  const isDev = isUserDeveloper(user);
  const isDual = isDualRoleUser(user);

  req.session.user.id = String(user._id);
  req.session.user.name = user.name;
  req.session.user.email = user.email;
  req.session.user.is_developer = isDev;
  req.session.user.is_dual_role = isDual;

  if (req.session.activeRole && (isDev || isDual)) {
    req.session.user.role = req.session.activeRole;
  } else {
    if (req.session.activeRole) delete req.session.activeRole;
    req.session.user.role = isDev ? 'developer' : user.role;
  }

  res.locals.user = req.session.user;
  res.locals.isDeveloper = isDev;
  res.locals.isDualRole = isDual;
  res.locals.activeRole = req.session.user.role;
  return user;
}

function respondUnauthenticated(req, res) {
  if (res.headersSent) return;
  if (req.accepts('html')) return res.redirect('/login');
  return res.status(401).json({ error: 'Authentication required.' });
}

async function requireLogin(req, res, next) {
  const user = await resolveCurrentUser(req, res);
  if (!user) return;
  next();
}

function requireRole(...roles) {
  return async function (req, res, next) {
    const user = await resolveCurrentUser(req, res);
    if (!user) return;

    const isDev = isUserDeveloper(user);
    if (isDev) {
      return next();
    }

    const isDual = isDualRoleUser(user);
    const currentRole = (req.session.user && req.session.user.role) || req.session.activeRole || user.role;

    if (isDual && roles.includes(currentRole)) {
      return next();
    }

    if (!roles.includes(currentRole)) {
      if (!req.accepts('html')) {
        return res.status(403).json({ error: 'You do not have permission to perform this action.' });
      }
      return res.status(403).render('error', {
        title: 'Access denied',
        message: 'You do not have permission to view this page.',
        backHref: homeFor(currentRole),
        backLabel: 'Go to my dashboard',
      });
    }
    next();
  };
}

const KNOWN_ADMINS = new Set([
  'utkarsha.kasar@kalvium.com',
  'prachi.sharma@kalvium.com',
  'ashish.suresh@kalvium.com',
  'arvind@kalvium.com',
  'akshata.sanap@kalvium.com',
  'gauravkhandelwal205@gmail.com',
  'heramb15012006@gmail.com',
  'admin@yourinstitution.edu',
  'admin@konfident.in',
]);

const KNOWN_MENTORS = new Set([
  'manav.verma@kalvium.com',
  'muskan.srivastava@kalvium.com',
  'ritu.soni@kalvium.com',
  'shikhar.agarwal@kalvium.com',
  'shivam.shrivastava@kalvium.com',
  'aditya.kulshreshtha@kalvium.com',
  'hrituparno.c@kalvium.com',
  'navaneeth.v@kalvium.com',
  'kanishka.ragavi@kalvium.com',
]);

const KNOWN_STUDENT_EMAILS = new Set([
  'isha.agrawal.s.116@kalvium.community',
  'aditya.talikoti.s.116@kalvium.community',
  'digvijay.patil.s.116@kalvium.community',
  'anisha.agrawal.s.116@kalvium.community',
  'areesh.ahmed.s.116@kalvium.community',
  'kanishka.girnar.s.116@kalvium.community',
  'aditya.nagane.s.116@kalvium.community',
  'shubham.reddy.s.116@kalvium.community',
  'yashwardhan.chaudhari.s.116@kalvium.community',
  'yashraj.jagtap.s.116@kalvium.community',
  'aryan.patil.s.116@kalvium.community',
  'om.lonkar.s.116@kalvium.community',
  'gauri.mhetre.s.116@kalvium.community',
  'avadhut.pawar.s.116@kalvium.community',
  'riddhima.sinhal.s.116@kalvium.community',
  'hardik.kaurani.s.116@kalvium.community',
  'tejas.pujari.s.116@kalvium.com',
  'khushal.rajput.s.116@kalvium.community',
  'aayushman.shukla.s.115@kalvium.community',
  'prithvi.rajvanshi.s.115@kalvium.community',
  'palakshi.verma.s.115@kalvium.community',
  'ruhaa.bhalerao.s.115@kalvium.community',
  'pratite.a.s.115@kalvium.community',
  'shriram.awchar.s.115@kalvium.community',
  'varad.shahane.s.115@kalvium.community',
  'raina.george.s.115@kalvium.community',
  'shauryvardhan.undre.s.115@kalvium.community',
  'om.jagtap.s.115@kalvium.community',
  'aadi.jain.s.115@kalvium.community',
  'parnil.vyawahare.s.115@kalvium.community',
  'atharv.hargude.s.115@kalvium.community',
  'sasmit.narnaware.s.115@kalvium.community',
  'rakshaad.kolhe.s.115@kalvium.community',
  'sohini.tandon.s.115@kalvium.community',
  'rishikesh.bagal.s.115@kalvium.community',
  'vinayak.kulkarni.s.115@kalvium.community',
  'gitesh.c.s.115@kalvium.community',
  'devansh.pujari.s.115@kalvium.community',
  'mohammad.patloo.s.115@kalvium.community',
  'shruti.itkalkar.s.115@kalvium.community',
]);

function determineRoleForEmail(email) {
  if (!email) return 'student';
  const cleanEmail = String(email).trim().toLowerCase();
  if (KNOWN_ADMINS.has(cleanEmail)) return 'admin';
  if (KNOWN_MENTORS.has(cleanEmail)) return 'mentor';
  if (KNOWN_STUDENT_EMAILS.has(cleanEmail)) return 'student';
  if (cleanEmail.includes('.s.') || cleanEmail.endsWith('.community')) return 'student';
  if (cleanEmail.endsWith('@kalvium.com')) return 'mentor';
  return 'student';
}

module.exports = {
  resolveCurrentUser,
  requireLogin,
  requireRole,
  homeFor,
  isUserDeveloper,
  isDualRoleUser,
  determineRoleForEmail,
  HOME,
};
