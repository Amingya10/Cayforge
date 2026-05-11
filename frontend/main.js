// This file is processed by Vite — sets API URL from environment variable
var env = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env : {};
window.__API_URL__ = env.VITE_API_URL || 'https://cayforge-production.up.railway.app';
window.__PAYSTACK_PK__ = env.VITE_PAYSTACK_PK || '';
