const { closePeer } = require("./closePeer");

const leaveHandler = ({ roomState, socketComm, sync, log, err }) => async (data) => {
  try {
    let { peerId } = (data.body);
    log('leave', peerId);

    await closePeer({ peerId: peerId, roomState: roomState });
    socketComm('leave', { left: true });
  } catch (e) {
    err('error in /signaling/leave', e);
    socketComm('leave', { error: e });
  } finally {
    sync();
  }
}
module.exports = { leaveHandler }