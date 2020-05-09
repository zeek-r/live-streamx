const fs = require("fs");
const config = require("../commons/config/");
const AWS = require("aws-sdk");

AWS.config.update({
  accessKeyId: config.s3AccessKey,
  secretAccessKey: config.s3SecretKey,
  region: config.s3Region
});

const s3 = new AWS.S3();

function putFile({ key = "", bucket = "", body }) {
  const s3Params = {
    Key: key,
    Bucket: bucket,
    Body: body
  };
  return s3.upload(s3Params).promise();
}


function pushRecordingS3({ file, fileName }) {
  const stream = fs.createReadStream(`./${file}`);
  console.log("file here", file);
  return putFile({
    key: `recordings/${fileName || file}`,
    bucket: config.bucket,
    body: stream
  })
}

module.exports = { pushRecordingS3 };