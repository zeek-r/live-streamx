const errorHandler = ({ err = console.error, socket }) => (err) => {
  error(`client: ${socket.id} connection error`, err);
}


module.exports = { errorHandler }