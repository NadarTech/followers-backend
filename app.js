require('dotenv').config({ path: './config/.env' });
const express = require('express');
const app = express();
const Queue = require("bull");
const axios = require("axios");

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

const userApi = require('./routes/user');
const paymentApi = require('./routes/payment');

app.use('/api/user', userApi);
app.use('/api/payment', paymentApi);

app.listen(process.env.PORT, () => {
  console.log(`Server is running on port ${process.env.PORT}`);
});
