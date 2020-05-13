const fs = require("fs");

const screenRecordingHandler = ({ log, recording }) => (data) => {
  const body = (data.body);
  let { recordingFile, recordingWriteStream } = recording;
  const uint8 = new Uint8Array(body.data);

  if (!recordingFile && !recordingWriteStream) {
    recordingFile = `Recording-${new Date()}`;
    recordingWriteStream = fs.createWriteStream(`./recordings/${recordingFile}`, { flags: 'a' });
  }
  recordingWriteStream.write(Buffer.from(uint8));
}
module.exports = { screenRecordingHandler }