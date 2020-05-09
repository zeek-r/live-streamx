module.exports = {
  useLocal: process.env.API_USE_LOCAL_APP === 'true' || false,
  sslCrt: process.env.API_SSL_CERT || undefined,
  sslKey: process.env.API_SSL_KEY || undefined
}