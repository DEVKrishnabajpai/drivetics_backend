require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const cloudinary = require('cloudinary').v2;
const admin = require('firebase-admin');

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO with CORS
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(cors({
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use('/uploads', express.static('uploads'));

const JWT_SECRET = process.env.JWT_SECRET;
const atlasUri = process.env.MONGO_URI;
// TEST_MODE / TEST_OTP removed – Firebase Auth handles OTP entirely

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Initialize Firebase Admin SDK
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // EC2 / Production (from env variable)
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  // Local development (from file)
  serviceAccount = require('./firebase-service-account.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('Created uploads directory');
}

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'), false);
    }
    cb(null, true);
  }
});

// Connect DB
mongoose.connect(atlasUri)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB connection error:", err));

// ==================== DATABASE SCHEMAS ====================

const UserSchema = new mongoose.Schema({
  phone: { type: String, unique: true, required: true, index: true },
  role: { type: String, enum: ['admin', 'customer', 'driver'], required: true, index: true },
  createdAt: { type: Date, default: Date.now },
  lastLoginAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", UserSchema);

const AdminSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const Admin = mongoose.model("Admin", AdminSchema);

const CustomerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  stats: {
    totalOrders: { type: Number, default: 0 },
    completedOrders: { type: Number, default: 0 }
  },
  createdAt: { type: Date, default: Date.now }
});

const Customer = mongoose.model("Customer", CustomerSchema);

const DriverSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  fatherName: { type: String, required: true },
  drivingLicense: { type: String, required: true }, // Cloudinary URL
  aadhar: { type: String, required: true }, // Cloudinary URL
  selfie: { type: String, required: true }, // Cloudinary URL
  
  approvalStatus: { 
    type: String, 
    enum: ['pending', 'approved', 'rejected'], 
    default: 'pending',
    index: true 
  },
  
  isActive: { type: Boolean, default: false },
  rejectionReason: { type: String },
  approvedAt: { type: Date },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  rejectedAt: { type: Date },
  
  lastActiveAt: { type: Date, default: Date.now },
  currentLocation: {
    latitude: { type: Number },
    longitude: { type: Number },
    updatedAt: { type: Date }
  },
  stats: {
    totalRides: { type: Number, default: 0 },
    completedRides: { type: Number, default: 0 }
  },
  createdAt: { type: Date, default: Date.now }
});

const Driver = mongoose.model("Driver", DriverSchema);

// OTP schema removed – Firebase Auth handles OTP generation, delivery, and verification natively

const OrderSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
  customerName: { type: String, required: true },
  customerPhone: { type: String, required: true },
  pickupLocation: { type: String, required: true },
  dropLocation: { type: String, required: true },
  pickupDateTime: { type: Date, required: true },
  vehicleCount: { type: Number, required: true },
  cost: { type: Number, default: null },
  status: { 
    type: String, 
    enum: ['pending', 'assigned', 'in_transit', 'completed', 'cancelled'],
    default: 'pending',
    index: true
  },
  assignments: [{
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "Driver" },
    driverName: { type: String },
    status: { type: String, enum: ['assigned', 'in_transit', 'completed'], default: 'assigned' },
    vehicleImages: [{ type: String }],
    currentLocation: {
      latitude: { type: Number },
      longitude: { type: Number },
      updatedAt: { type: Date }
    },
    assignedAt: { type: Date, default: Date.now },
    startedAt: { type: Date },
    completedAt: { type: Date }
  }],
  createdAt: { type: Date, default: Date.now },
  completedAt: { type: Date }
});

const Order = mongoose.model("Order", OrderSchema);

const NotificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  type: { type: String, enum: ['order', 'assignment', 'status', 'approval'], required: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
  isRead: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const Notification = mongoose.model("Notification", NotificationSchema);

// ==================== WEBSOCKET SETUP ====================

const connectedClients = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Authentication error'));
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    socket.userRole = decoded.role;
    next();
  } catch (err) {
    next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.userId} (${socket.userRole})`);
  connectedClients.set(socket.userId, { socket, role: socket.userRole });
  socket.join(socket.userRole);
  
  socket.on('driver:status_change', async (data) => {
    try {
      const driver = await Driver.findOne({ userId: socket.userId });
      if (driver && driver.approvalStatus === 'approved') {
        driver.isActive = data.isActive;
        driver.lastActiveAt = new Date();
        await driver.save();
        
        io.to('admin').emit('driver:status_updated', {
          driverId: driver._id,
          name: driver.name,
          isActive: data.isActive
        });
      }
    } catch (err) {
      console.error('Driver status change error:', err);
    }
  });
  
  socket.on('driver:location_update', async (data) => {
    try {
      const driver = await Driver.findOne({ userId: socket.userId });
      if (driver) {
        driver.currentLocation = {
          latitude: data.latitude,
          longitude: data.longitude,
          updatedAt: new Date()
        };
        await driver.save();
        
        io.to('admin').emit('driver:location_updated', {
          driverId: driver._id,
          location: driver.currentLocation
        });
      }
    } catch (err) {
      console.error('Driver location update error:', err);
    }
  });
  
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.userId}`);
    connectedClients.delete(socket.userId);
  });
});

function emitToUser(userId, event, data) {
  const client = connectedClients.get(userId.toString());
  if (client) {
    client.socket.emit(event, data);
  }
}

function emitToAdmins(event, data) {
  io.to('admin').emit(event, data);
}

// ==================== HELPER FUNCTIONS ====================

// Validate Indian phone number format
function validatePhone(phone) {
  const regex = /^\+91[6-9]\d{9}$/;
  return regex.test(phone);
}

// generateOTP / checkOTPRateLimit removed – Firebase Auth enforces its own rate limits
async function uploadToCloudinary(filePath, folder) {
  try {
    const result = await cloudinary.uploader.upload(filePath, {
      folder: folder,
      resource_type: 'image'
    });
    
    // Delete local file after upload
    fs.unlinkSync(filePath);
    
    return result.secure_url;
  } catch (error) {
    console.error('Cloudinary upload error:', error);
    throw new Error('File upload failed');
  }
}



// ==================== AUTH MIDDLEWARE ====================

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    next();
  } catch (err) {
    console.error('Token verification error:', err);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ==================== AUTHENTICATION ENDPOINTS ====================

// Send OTP – triggers Firebase phone auth on the CLIENT side.
// This endpoint only validates the phone format so the client can
// call FirebaseAuth.instance.verifyPhoneNumber() itself.
// Firebase sends the SMS automatically; no OTP is stored server-side.
app.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    // Validate phone format
    if (!validatePhone(phone)) {
      return res.status(400).json({ error: "Invalid phone number format. It can only start with 6/7/8/9" });
    }

    // Nothing else to do – the Flutter client will call
    // FirebaseAuth.instance.verifyPhoneNumber() which triggers the SMS.
    res.json({
      success: true,
      message: "Proceed with Firebase phone verification on client"
    });

  } catch (err) {
    console.error("Send OTP error:", err);
    res.status(500).json({ error: "Failed to process OTP request" });
  }
});

// Verify OTP – the client has already completed Firebase phone auth and
// obtained a Firebase ID token.  We verify that token here with the
// Firebase Admin SDK, extract the phone number, and then do the same
// login / new-user logic as before.
app.post('/verify-otp', async (req, res) => {
  try {
    const { firebaseToken } = req.body;   // Firebase ID token from client

    if (!firebaseToken) {
      return res.status(400).json({ error: "Firebase token is required" });
    }

    // ── 1. Verify the Firebase ID token ──────────────────────────
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(firebaseToken);
    } catch (err) {
      console.error("Firebase token verification failed:", err);
      return res.status(401).json({ error: "Invalid or expired Firebase token" });
    }

    const phone = decodedToken.phone_number;   // e.g. "+919307128962"
    if (!phone) {
      return res.status(400).json({ error: "Phone number not found in token" });
    }

    console.log(`Firebase phone auth verified for: ${phone}`);

    // ── 2. Existing-user login  OR  new-user flag ────────────────
    let user = await User.findOne({ phone: phone });

    if (user) {
      // Existing user – login
      user.lastLoginAt = new Date();
      await user.save();

      let roleData = null;
      let approvalStatus = 'approved';
      let rejectionReason = null;

      if (user.role === 'customer') {
        roleData = await Customer.findOne({ userId: user._id });
      } else if (user.role === 'driver') {
        const driver = await Driver.findOne({ userId: user._id });
        if (driver) {
          roleData = driver;
          approvalStatus = driver.approvalStatus;
          rejectionReason = driver.rejectionReason;
        }
      } else if (user.role === 'admin') {
        roleData = await Admin.findOne({ userId: user._id });
      }

      // Generate JWT token (30 days expiry)
      const token = jwt.sign(
        { userId: user._id, role: user.role },
        JWT_SECRET,
        { expiresIn: "30d" }
      );

      res.json({
        success: true,
        isNewUser: false,
        token: token,
        user: {
          id: user._id,
          phone: user.phone,
          role: user.role,
          name: roleData ? roleData.name : null
        },
        approvalStatus: approvalStatus,
        rejectionReason: rejectionReason
      });

    } else {
      // New user – tell the client to show role-selection
      res.json({
        success: true,
        isNewUser: true,
        phone: phone,
        message: "Please complete signup"
      });
    }

  } catch (err) {
    console.error("Verify OTP error:", err);
    res.status(500).json({ error: "OTP verification failed" });
  }
});

// Complete customer signup
app.post('/customer-signup', async (req, res) => {
  try {
    const { phone, name } = req.body;

    if (!phone || !name) {
      return res.status(400).json({ error: "Phone and name are required" });
    }

    

    // Check if user already exists
    const existingUser = await User.findOne({ phone: phone });
    if (existingUser) {
      return res.status(409).json({ error: "Phone number already registered" });
    }

    // Verify the Firebase token is still valid for this phone
    const { firebaseToken } = req.body;
    if (!firebaseToken) {
      return res.status(400).json({ error: "Firebase token is required for signup" });
    }
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(firebaseToken);
    } catch (err) {
      return res.status(401).json({ error: "Invalid Firebase token. Please verify your phone again." });
    }
   const tokenPhone = decodedToken.phone_number.replace(/\D/g, "");
const reqPhone = phone.replace(/\D/g, "");

if (!tokenPhone.endsWith(reqPhone)) {
  return res.status(400).json({ error: "Token phone mismatch" });
}

    // Create User record
    const user = new User({
      phone: phone,
      role: 'customer'
    });
    await user.save();

    // Create Customer record
    const customer = new Customer({
      userId: user._id,
      name: name,
      phone: phone
    });
    await customer.save();

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.status(201).json({
      success: true,
      message: "Customer registration successful",
      token: token,
      user: {
        id: user._id,
        phone: user.phone,
        role: user.role,
        name: customer.name
      }
    });

  } catch (err) {
    console.error("Customer signup error:", err);
    res.status(500).json({ error: "Customer registration failed" });
  }
});

// Complete driver signup with documents
app.post('/driver-signup', upload.fields([
  { name: 'drivingLicense', maxCount: 1 },
  { name: 'aadhar', maxCount: 1 },
  { name: 'selfie', maxCount: 1 }
]), async (req, res) => {
  try {
    const { phone, name, fatherName } = req.body;

    if (!phone || !name || !fatherName) {
      return res.status(400).json({ error: "Phone, name, and father's name are required" });
    }

    // Validate phone
    if (!validatePhone(phone)) {
      return res.status(400).json({ error: "Invalid phone number" });
    }

    // Check if all files are uploaded
    if (!req.files || !req.files.drivingLicense || !req.files.aadhar || !req.files.selfie) {
      return res.status(400).json({ error: "All documents (DL, Aadhar, Selfie) are required" });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ phone: phone });
    if (existingUser) {
      return res.status(409).json({ error: "Phone number already registered" });
    }

    // Verify the Firebase token is still valid for this phone
    const { firebaseToken } = req.body;
    if (!firebaseToken) {
      return res.status(400).json({ error: "Firebase token is required for signup" });
    }
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(firebaseToken);
    } catch (err) {
      return res.status(401).json({ error: "Invalid Firebase token. Please verify your phone again." });
    }
    if (decodedToken.phone_number !== phone) {
      return res.status(400).json({ error: "Token phone mismatch" });
    }

    // Upload documents to Cloudinary
    const dlPath = req.files.drivingLicense[0].path;
    const aadharPath = req.files.aadhar[0].path;
    const selfiePath = req.files.selfie[0].path;

    const dlUrl = await uploadToCloudinary(dlPath, 'drivetics/drivers/dl');
    const aadharUrl = await uploadToCloudinary(aadharPath, 'drivetics/drivers/aadhar');
    const selfieUrl = await uploadToCloudinary(selfiePath, 'drivetics/drivers/selfie');

    // Create User record
    const user = new User({
      phone: phone,
      role: 'driver'
    });
    await user.save();

    // Create Driver record
    const driver = new Driver({
      userId: user._id,
      name: name,
      phone: phone,
      fatherName: fatherName,
      drivingLicense: dlUrl,
      aadhar: aadharUrl,
      selfie: selfieUrl,
      approvalStatus: 'pending'
    });
    await driver.save();

    // Notify all admins
    const admins = await User.find({ role: 'admin' });
    for (let admin of admins) {
      await new Notification({
        userId: admin._id,
        title: "New Driver Registration",
        message: `${name} has registered as a driver and needs approval`,
        type: 'approval'
      }).save();
    }

    emitToAdmins('driver:new_registration', {
      driverId: driver._id,
      name: driver.name,
      phone: driver.phone
    });

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.status(201).json({
      success: true,
      message: "Driver registration successful. Awaiting approval.",
      token: token,
      user: {
        id: user._id,
        phone: user.phone,
        role: user.role,
        name: driver.name
      },
      approvalStatus: 'pending'
    });

  } catch (err) {
    console.error("Driver signup error:", err);
    res.status(500).json({ error: "Driver registration failed" });
  }
});

// Token Verification
app.get('/verify-token', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let roleData = null;
    let approvalStatus = 'approved';
    let rejectionReason = null;

    if (user.role === 'customer') {
      roleData = await Customer.findOne({ userId: user._id });
    } else if (user.role === 'driver') {
      const driver = await Driver.findOne({ userId: user._id });
      if (driver) {
        roleData = driver;
        approvalStatus = driver.approvalStatus;
        rejectionReason = driver.rejectionReason;
      }
    } else if (user.role === 'admin') {
      roleData = await Admin.findOne({ userId: user._id });
    }

    res.json({
      valid: true,
      user: {
        id: user._id,
        phone: user.phone,
        role: user.role,
        name: roleData ? roleData.name : null
      },
      approvalStatus: approvalStatus,
      rejectionReason: rejectionReason
    });

  } catch (error) {
    console.error('Token verification error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ==================== ADMIN DRIVER APPROVAL ENDPOINTS ====================

// Get all pending drivers
app.get('/admin/pending-drivers', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const pendingDrivers = await Driver.find({ approvalStatus: 'pending' })
      .populate('userId', 'phone')
      .sort({ createdAt: -1 });

    res.json(pendingDrivers);
  } catch (error) {
    console.error('Get pending drivers error:', error);
    res.status(500).json({ error: 'Failed to fetch pending drivers' });
  }
});

// Approve driver
app.post('/admin/approve-driver/:driverId', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const driver = await Driver.findById(req.params.driverId);
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    driver.approvalStatus = 'approved';
    driver.approvedAt = new Date();
    driver.approvedBy = req.userId;
    driver.rejectionReason = null;
    await driver.save();

    // Notify driver
    await new Notification({
      userId: driver.userId,
      title: "Application Approved",
      message: "Your driver application has been approved! You can now start accepting rides.",
      type: 'approval'
    }).save();

    emitToUser(driver.userId, 'driver:approved', {
      message: "Your application has been approved"
    });

    res.json({ 
      success: true, 
      message: "Driver approved successfully" 
    });
  } catch (error) {
    console.error('Approve driver error:', error);
    res.status(500).json({ error: 'Failed to approve driver' });
  }
});

// Reject driver
app.post('/admin/reject-driver/:driverId', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { reason } = req.body;
    if (!reason) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }

    const driver = await Driver.findById(req.params.driverId);
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    driver.approvalStatus = 'rejected';
    driver.rejectionReason = reason;
    driver.rejectedAt = new Date();
    await driver.save();

    // Notify driver
    await new Notification({
      userId: driver.userId,
      title: "Application Rejected",
      message: `Your driver application has been rejected. Reason: ${reason}`,
      type: 'approval'
    }).save();

    emitToUser(driver.userId, 'driver:rejected', {
      reason: reason
    });

    res.json({ 
      success: true, 
      message: "Driver rejected" 
    });
  } catch (error) {
    console.error('Reject driver error:', error);
    res.status(500).json({ error: 'Failed to reject driver' });
  }
});

// ==================== ORDER ENDPOINTS ====================

app.post('/orders/create', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'customer') {
      return res.status(403).json({ error: "Only customers can create orders" });
    }

    const { pickupLocation, dropLocation, pickupDateTime, vehicleCount } = req.body;

    if (!pickupLocation || !dropLocation || !pickupDateTime || !vehicleCount) {
      return res.status(400).json({ error: "All order details are required" });
    }

    const customer = await Customer.findOne({ userId: req.userId });
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const newOrder = new Order({
      customerId: customer._id,
      customerName: customer.name,
      customerPhone: customer.phone,
      pickupLocation,
      dropLocation,
      pickupDateTime: new Date(pickupDateTime),
      vehicleCount: parseInt(vehicleCount),
      status: 'pending'
    });

    await newOrder.save();

    customer.stats.totalOrders += 1;
    await customer.save();

    const admins = await User.find({ role: 'admin' });
    for (let admin of admins) {
      await new Notification({
        userId: admin._id,
        title: "New Order",
        message: `${customer.name} placed a new order`,
        type: 'order',
        orderId: newOrder._id
      }).save();
    }

    emitToAdmins('order:new', {
      order: newOrder
    });

    res.status(201).json({ 
      message: "Order placed successfully",
      order: newOrder
    });
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get('/orders/my-orders', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'customer') {
      return res.status(403).json({ error: "Access denied" });
    }

    const customer = await Customer.findOne({ userId: req.userId });
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const orders = await Order.find({ customerId: customer._id })
      .sort({ createdAt: -1 });

    res.json(orders);
  } catch (err) {
    console.error('Get orders error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get('/orders/:id', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json(order);
  } catch (err) {
    console.error('Get order error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== PROFILE & NOTIFICATIONS ====================

app.get('/profile', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let roleData = null;
    if (user.role === 'customer') {
      roleData = await Customer.findOne({ userId: user._id });
    } else if (user.role === 'driver') {
      roleData = await Driver.findOne({ userId: user._id });
    } else if (user.role === 'admin') {
      roleData = await Admin.findOne({ userId: user._id });
    }

    res.json({
      user: {
        id: user._id,
        phone: user.phone,
        role: user.role
      },
      roleData: roleData
    });
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

app.get('/admin/drivers', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const drivers = await Driver.find({ approvalStatus: 'approved' })
      .populate('userId', 'phone');
    res.json(drivers);
  } catch (error) {
    console.error('Get drivers error:', error);
    res.status(500).json({ error: 'Failed to fetch drivers' });
  }
});

app.get('/admin/customers', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const customers = await Customer.find().populate('userId', 'phone');
    res.json(customers);
  } catch (error) {
    console.error('Get customers error:', error);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

app.get('/notifications', authMiddleware, async (req, res) => {
  try {
    const notifications = await Notification.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(20);
    res.json(notifications);
  } catch (err) {
    console.error('Get notifications error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

app.put('/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    await Notification.findByIdAndUpdate(req.params.id, { isRead: true });
    res.json({ message: "Notification marked as read" });
  } catch (err) {
    console.error('Mark notification read error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket server is ready`);
  console.log(`Uploads directory: ${uploadsDir}`);
  console.log(`Test mode: DISABLED (using Firebase Auth)`);
  console.log('\n🔐 Authentication Endpoints:');
  console.log('  POST /send-otp - Send OTP to phone');
  console.log('  POST /verify-otp - Verify OTP and login/check if new user');
  console.log('  POST /customer-signup - Complete customer registration');
  console.log('  POST /driver-signup - Complete driver registration with documents');
  console.log('  GET  /verify-token - Verify JWT token\n');
  console.log('👮 Admin Endpoints:');
  console.log('  GET  /admin/pending-drivers - Get pending driver approvals');
  console.log('  POST /admin/approve-driver/:driverId - Approve driver');
  console.log('  POST /admin/reject-driver/:driverId - Reject driver\n');
});