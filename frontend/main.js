// This file is processed by Vite — sets API URL from environment variable
window.__API_URL__ = import.meta.env.VITE_API_URL || 'http://localhost:3001';
window.__PAYSTACK_PK__ = import.meta.env.VITE_PAYSTACK_PK || '';
