const mongoose = require('mongoose');

const apiTokenSchema = new mongoose.Schema({
  apiToken: String,
  email: String,
  fullname: String,
  scope: [String],
  user_id: Number,
  readyForTrade: Boolean,
});

const Api = mongoose.model('Api', apiTokenSchema);

module.exports = { Api };