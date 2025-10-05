require('dotenv').config({ path: './config/.env' });
const express = require('express');
const app = express();
const admin = require('firebase-admin');
const { HttpsProxyAgent } = require('https-proxy-agent');
const serviceAccount = require('./config/firebase-key.json');

// Proxy agent oluştur
const proxyAgent = new HttpsProxyAgent('http://127.0.0.1:8001');

// Firebase Admin'i başlat
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  httpAgent: proxyAgent,
});
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

const userApi = require('./routes/user');
const paymentApi = require('./routes/payment');

app.use('/api/user', userApi);
app.use('/api/payment', paymentApi);

app.listen(process.env.PORT, () => {
  console.log(`Server is running on port ${process.env.PORT}`);
});
