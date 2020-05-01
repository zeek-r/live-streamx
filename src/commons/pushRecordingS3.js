const fs = require("fs");
const config = require("./config");
const AWS = require("aws-sdk");

AWS.config.update({
  accessKeyId: config.s3AccessKey,
  secretAccessKey: config.s3SecretKey,
  region: config.s3Region
});

function putFile({ key = "", bucket = "", body }) {
  const s3Params = {
    Key: key,
    Bucket: bucket,
    Body: body
  };
  return s3.upload(s3Params).promise();
}


function pushRecordingS3({ file, fileName }) {
  const stream = fs.createReadStream(file);
  return putFile({
    key: `recordings/${fileName || file}`,
    bucket: config.s3Bucket,
    body: stream
  })
}

module.exports = { pushRecordingS3 };