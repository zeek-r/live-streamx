const disconnectHandler = ({ log = console.log, socket, sync }) => () => {
  log(`Client: ${socket.id} disconnected`);
  sync();
}


module.exports = { disconnectHandler }