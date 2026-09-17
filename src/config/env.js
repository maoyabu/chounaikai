const required = (name) => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export const loadConfig = () => ({
  mongoUri: required('MONGODB_URI'),
  sessionSecret: required('CHOUNAIKAI_SESSION_SECRET'),
  port: Number(process.env.PORT || 3003),
  nodeEnv: process.env.NODE_ENV || 'development'
});
