const { pushRecordingS3 } = require("../../../commons/pushRecordingS3");

async function handleRecording({ recordingFile, recordingWriteStream }) {
  try {
    if (recordingFile && recordingWriteStream) {
      await pushRecordingS3({ file: `recordings/${recordingFile}` });
      recordingFile = null;
      recordingWriteStream = null;
    }
  } catch (error) {
    console.error(error);
  }
}

module.exports = { handleRecording }