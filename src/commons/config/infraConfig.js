module.exports = {
  s3AccessKey: process.env.AWS_ACCESS_KEY || "",
  s3SecretKey: process.env.AWS_SECRET_KEY || "",
  s3Region: process.env.AWS_REGION || "",
  bucket: process.env.AWS_BUCKET || "",
  apiPort: process.env.API_PORT || 3000,
  listenIp: '0.0.0.0',
  listenPort: 3000,
}