export default () => ({
  port: parseInt(process.env.PORT || '3001', 10),
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },
  convex: {
    url: process.env.CONVEX_URL,
  },
  cors: {
    origins: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:8081'],
  },
  // Lenco Payment Gateway
  lenco: {
    apiKey: process.env.LENCO_API_KEY,
    secretKey: process.env.LENCO_SECRET_KEY,
    accountId: process.env.LENCO_ACCOUNT_ID,
    webhookSecret: process.env.LENCO_WEBHOOK_SECRET,
    baseUrl: process.env.LENCO_BASE_URL || 'https://api.lenco.co/access/v2',
  },
  app: {
    url: process.env.APP_URL || 'https://gettitonline.com',
  },
});
