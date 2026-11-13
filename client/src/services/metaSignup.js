// WhatsApp Embedded Signup in the browser: loads Meta's Facebook JS SDK, opens the signup popup, and hands back what Meta returns (the one-time
// code and the ids of the WhatsApp Business Account and phone number). The code is exchanged for a token on the SERVER; this file never sees one.
let sdk;
function loadSdk({ appId, graphVersion }) {
  if (sdk) return sdk;
  sdk = new Promise((resolve, reject) => {
    window.fbAsyncInit = () => { window.FB.init({ appId, cookie: true, xfbml: false, version: graphVersion }); resolve(window.FB); };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js'; s.async = true; s.defer = true; s.crossOrigin = 'anonymous';
    s.onerror = () => { sdk = null; reject(new Error('Meta’s sign-up script could not be loaded. Check your connection or ad blocker.')); };
    document.body.appendChild(s);
  });
  return sdk;
}

export async function launchWhatsAppSignup({ appId, configId, graphVersion }) {
  const FB = await loadSdk({ appId, graphVersion });
  return new Promise((resolve, reject) => {
    let session = null;
    const onMessage = (e) => {
      if (!/(^|\.)facebook\.com$/.test(new URL(e.origin).hostname)) return;
      try {
        const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (d?.type !== 'WA_EMBEDDED_SIGNUP') return;
        if (d.event === 'CANCEL') reject(new Error('Sign-up was cancelled.'));
        else if (d.event === 'ERROR') reject(new Error(d.data?.error_message || 'Meta reported an error during sign-up.'));
        else if (d.data?.waba_id && d.data?.phone_number_id) session = { wabaId: d.data.waba_id, phoneNumberId: d.data.phone_number_id };
      } catch { /* not ours */ }
    };
    window.addEventListener('message', onMessage);
    FB.login((response) => {
      const code = response?.authResponse?.code;
      // The session event and the login callback arrive separately; wait briefly for the ids.
      const wait = (n) => (session || n === 0 ? finish() : setTimeout(() => wait(n - 1), 250));
      const finish = () => { window.removeEventListener('message', onMessage); if (code && session) resolve({ code, ...session }); else reject(new Error(code ? 'Meta did not return the WhatsApp account details. Try again.' : 'Sign-up was not completed.')); };
      wait(20);
    }, { config_id: configId, response_type: 'code', override_default_response_type: true, extras: { setup: {} } });
  });
}
