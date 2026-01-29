require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { OAuth2Client } = require('google-auth-library');
const sendAdminEmail = require("./utils/mailer");
const http = require('http');
const { Server } = require('socket.io');

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

// Multiple Google Client IDs for different platforms
const GOOGLE_CLIENT_IDS = {
  web: process.env.GOOGLE_CLIENT_ID_WEB,
  android: process.env.GOOGLE_CLIENT_ID_ANDROID,
  ios: process.env.GOOGLE_CLIENT_ID_IOS
};

// Create OAuth2Client instances for each platform
const googleClients = {
  web: new OAuth2Client(GOOGLE_CLIENT_IDS.web),
  android: new OAuth2Client(GOOGLE_CLIENT_IDS.android),
  ios: new OAuth2Client(GOOGLE_CLIENT_IDS.ios)
};

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
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// Connect DB
mongoose.connect(atlasUri)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB connection error:", err));

// ==================== DATABASE SCHEMAS ====================

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, unique: true, required: true, index: true },
  password: { type: String },
  role: { type: String, enum: ['admin', 'customer', 'driver'], required: true, index: true },
  googleId: { type: String, unique: true, sparse: true, index: true },
  authProvider: { type: String, enum: ['local', 'google'], default: 'local' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", UserSchema);

// ENHANCED DRIVER SCHEMA with approval workflow
const DriverSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String, required: true },
  profilePhoto: { type: String, required: true }, // Required during registration
  
  // Approval Status: 'pending', 'approved', 'rejected'
  approvalStatus: { 
    type: String, 
    enum: ['pending', 'approved', 'rejected'], 
    default: 'pending',
    index: true 
  },
  
  isActive: { type: Boolean, default: false }, // Only matters after approval
  rejectionReason: { type: String }, // If rejected, admin can provide reason
  approvedAt: { type: Date },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // Admin who approved
  
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

const CustomerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String },
  stats: {
    totalOrders: { type: Number, default: 0 },
    completedOrders: { type: Number, default: 0 }
  },
  createdAt: { type: Date, default: Date.now }
});

const Customer = mongoose.model("Customer", CustomerSchema);

const OrderSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
  customerName: { type: String, required: true },
  customerEmail: { type: String, required: true },
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

const CustomerIntentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String, required: true },
  message: { type: String },
  createdAt: { type: Date, default: Date.now }
});

const CustomerIntent = mongoose.model("customer_intent", CustomerIntentSchema);

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

// ==================== HELPER FUNCTIONS ====================

async function createUserWithRole(userData) {
  const { name, email, password, role, googleId, authProvider, profilePhoto } = userData;
  
  // Create user account
  const user = new User({
    name,
    email,
    password,
    role,
    googleId,
    authProvider: authProvider || 'local'
  });
  
  await user.save();
  
  // Create role-specific record
  if (role === 'customer') {
    await new Customer({
      userId: user._id,
      name: user.name,
      email: user.email
    }).save();
  } else if (role === 'driver') {
    await new Driver({
      userId: user._id,
      name: user.name,
      email: user.email,
      profilePhoto: profilePhoto,
      approvalStatus: 'pending',
      isActive:false

    }).save();
    
    // Notify all admins about new driver registration
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
      driverId: user._id,
      name: user.name,
      email: user.email
    });
  }
  // Admin role doesn't need additional record
  
  return user;
}

// ==================== AUTHENTICATION ENDPOINTS ====================

// Manual Registration
app.post('/register', upload.single('driverPhoto'), async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: "All fields are required" });
    }

    if (!['customer', 'driver', 'admin'].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    // 🔒 Enforce photo ONLY for drivers
    if (role === 'driver' && !req.file) {
      return res.status(400).json({ error: "Driver profile photo is required" });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // ✅ User has NO photo
    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      role,
      authProvider: 'local'
    });

    // ✅ Driver photo stored ONLY here
    if (role === 'driver') {
      await Driver.create({
        userId: user._id,
        profilePhoto: `/uploads/${req.file.filename}`,
        approvalStatus: 'pending',
        isActive: false
      });
    }

    const token = jwt.sign(
      { userId: user._id, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.status(201).json({
      message: "Registration successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      },
      requiresProfileCompletion: role === 'driver'
    });

  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});


// Manual Login
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    // Check if account uses Google auth
    if (user.authProvider === 'google') {
      return res.status(400).json({ 
        error: "This account uses Google Sign-In. Please use 'Sign in with Google'" 
      });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Get approval status for drivers
    let approvalStatus = 'approved';
    let rejectionReason = null;
    
    if (user.role === 'driver') {
      const driver = await Driver.findOne({ userId: user._id });
      if (driver) {
        approvalStatus = driver.approvalStatus;
        rejectionReason = driver.rejectionReason;
      }
    }

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      approvalStatus,
      rejectionReason
    });

  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// Google Sign-In (for existing users)
app.post('/google-login', async (req, res) => {
  try {
    const { idToken, platform = 'android' } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: "ID token is required" });
    }

    // Verify the Google ID token
    const client = googleClients[platform] || googleClients.android;
    
    let ticket;
    try {
      ticket = await client.verifyIdToken({
        idToken,
        audience: [
          GOOGLE_CLIENT_IDS.web,
          GOOGLE_CLIENT_IDS.android,
          GOOGLE_CLIENT_IDS.ios
        ].filter(Boolean)
      });
    } catch (verifyError) {
      console.error("Token verification error:", verifyError);
      return res.status(400).json({ error: "Invalid Google token" });
    }

    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    // Find user by Google ID or email
    let user = await User.findOne({ $or: [{ googleId }, { email }] });

    if (!user) {
      return res.status(404).json({ 
        error: "No account found. Please sign up first." 
      });
    }

    // If found by email but not linked to Google, link it
    if (!user.googleId) {
      user.googleId = googleId;
      user.authProvider = 'google';
      await user.save();
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Get approval status for drivers
    let approvalStatus = 'approved';
    let rejectionReason = null;
    
    if (user.role === 'driver') {
      const driver = await Driver.findOne({ userId: user._id });
      if (driver) {
        approvalStatus = driver.approvalStatus;
        rejectionReason = driver.rejectionReason;
      }
    }

    res.json({
      message: "Google sign-in successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      approvalStatus,
      rejectionReason
    });

  } catch (err) {
    console.error("Google login error:", err);
    res.status(500).json({ error: "Google sign-in failed" });
  }
});

// Google Sign-Up (for new customers and admins)
app.post('/google-signup', async (req, res) => {
  try {
    const { idToken, role, platform = 'android' } = req.body;

    if (!idToken || !role) {
      return res.status(400).json({ error: "ID token and role are required" });
    }

    if (!['customer', 'admin'].includes(role)) {
      return res.status(400).json({ 
        error: "Invalid role. Drivers must use driver-specific signup." 
      });
    }

    // Verify the Google ID token
    const client = googleClients[platform] || googleClients.android;
    
    let ticket;
    try {
      ticket = await client.verifyIdToken({
        idToken,
        audience: [
          GOOGLE_CLIENT_IDS.web,
          GOOGLE_CLIENT_IDS.android,
          GOOGLE_CLIENT_IDS.ios
        ].filter(Boolean)
      });
    } catch (verifyError) {
      console.error("Token verification error:", verifyError);
      return res.status(400).json({ error: "Invalid Google token" });
    }

    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    // Check if user already exists
    let user = await User.findOne({ $or: [{ googleId }, { email }] });

    if (user) {
      return res.status(400).json({ 
        error: "Account already exists. Please sign in." 
      });
    }

    // Create new user with role-specific record
    user = await createUserWithRole({
      name,
      email,
      role,
      googleId,
      authProvider: 'google'
    });

    // Generate JWT
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.status(201).json({
      message: "Google sign-up successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      approvalStatus: 'approved' // Customer and admin are auto-approved
    });

  } catch (err) {
    console.error("Google signup error:", err);
    res.status(500).json({ error: "Google sign-up failed" });
  }
});

// Google Driver Sign-Up (with photo upload)
app.post('/google-driver-signup', upload.single('driverPhoto'), async (req, res) => {
  try {
    const { idToken, platform = 'android' } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: "ID token is required" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Driver profile photo is required" });
    }

    // Verify the Google ID token
    const client = googleClients[platform] || googleClients.android;
    
    let ticket;
    try {
      ticket = await client.verifyIdToken({
        idToken,
        audience: [
          GOOGLE_CLIENT_IDS.web,
          GOOGLE_CLIENT_IDS.android,
          GOOGLE_CLIENT_IDS.ios
        ].filter(Boolean)
      });
    } catch (verifyError) {
      console.error("Token verification error:", verifyError);
      return res.status(400).json({ error: "Invalid Google token" });
    }

    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    // Check if user already exists
    let user = await User.findOne({ $or: [{ googleId }, { email }] });

    if (user) {
      return res.status(400).json({ 
        error: "Account already exists. Please sign in." 
      });
    }

    // Create new driver user
    user = await createUserWithRole({
      name,
      email,
      role: 'driver',
      googleId,
      authProvider: 'google',
      profilePhoto: `/uploads/${req.file.filename}`
    });

    // Generate JWT
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.status(201).json({
      message: "Driver registration successful. Awaiting approval.",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      approvalStatus: 'pending'
    });

  } catch (err) {
    console.error("Google driver signup error:", err);
    res.status(500).json({ error: "Driver registration failed" });
  }
});

// Token Verification Endpoint
app.get('/verify-token', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let approvalStatus = 'approved';
    let rejectionReason = null;
    
    if (user.role === 'driver') {
      const driver = await Driver.findOne({ userId: user._id });
      if (driver) {
        approvalStatus = driver.approvalStatus;
        rejectionReason = driver.rejectionReason;
      }
    }

    res.json({
      valid: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      approvalStatus,
      rejectionReason
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
      .populate('userId', 'name email createdAt')
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

    // Notify the driver
    await new Notification({
      userId: driver.userId,
      title: "Account Approved",
      message: "Your driver account has been approved! You can now start accepting rides.",
      type: 'approval'
    }).save();

    emitToUser(driver.userId, 'driver:approved', {
      message: 'Your account has been approved'
    });

    res.json({ 
      message: 'Driver approved successfully',
      driver 
    });

  } catch (error) {
    console.error('Approve driver error:', error);
    res.status(500).json({ error: 'Approval failed' });
  }
});

// Reject driver
app.post('/admin/reject-driver/:driverId', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { reason } = req.body;

    const driver = await Driver.findById(req.params.driverId);
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    driver.approvalStatus = 'rejected';
    driver.rejectionReason = reason || 'Your application did not meet our requirements.';
    await driver.save();

    // Notify the driver
    await new Notification({
      userId: driver.userId,
      title: "Account Rejected",
      message: driver.rejectionReason,
      type: 'approval'
    }).save();

    emitToUser(driver.userId, 'driver:rejected', {
      message: driver.rejectionReason
    });

    res.json({ 
      message: 'Driver rejected',
      driver 
    });

  } catch (error) {
    console.error('Reject driver error:', error);
    res.status(500).json({ error: 'Rejection failed' });
  }
});

// ==================== ADMIN ENDPOINTS ====================

app.get('/admin/all-orders', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const orders = await Order.find()
      .sort({ createdAt: -1 })
      .limit(100);

    res.json(orders);
  } catch (error) {
    console.error('Get all orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.post('/admin/assign-drivers', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { orderId, driverIds, cost } = req.body;

    if (!orderId || !driverIds || !Array.isArray(driverIds) || driverIds.length === 0) {
      return res.status(400).json({ error: 'Order ID and driver IDs are required' });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Clear existing assignments
    order.assignments = [];

    // Assign drivers
    for (let driverId of driverIds) {
      const driver = await Driver.findById(driverId);
      if (driver && driver.approvalStatus === 'approved') {
        order.assignments.push({
          driverId: driver._id,
          driverName: driver.name,
          status: 'assigned'
        });

        // Notify driver
        await new Notification({
          userId: driver.userId,
          title: 'New Assignment',
          message: `You have been assigned to an order from ${order.pickupLocation} to ${order.dropLocation}`,
          type: 'assignment',
          orderId: order._id
        }).save();

        emitToUser(driver.userId, 'order:assigned', {
          orderId: order._id,
          order: order
        });
      }
    }

    order.status = 'assigned';
    if (cost) {
      order.cost = cost;
    }
    await order.save();

    // Notify customer
    const customer = await Customer.findById(order.customerId);
    if (customer) {
      await new Notification({
        userId: customer.userId,
        title: 'Drivers Assigned',
        message: `Drivers have been assigned to your order`,
        type: 'status',
        orderId: order._id
      }).save();

      emitToUser(customer.userId, 'order:drivers_assigned', {
        orderId: order._id,
        driverCount: order.assignments.length
      });
    }

    res.json({
      message: 'Drivers assigned successfully',
      order
    });

  } catch (error) {
    console.error('Assign drivers error:', error);
    res.status(500).json({ error: 'Assignment failed' });
  }
});

// ==================== DRIVER ENDPOINTS ====================

app.get('/driver/my-assignments', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    if (!driver) {
      return res.status(404).json({ error: 'Driver profile not found' });
    }

    if (driver.approvalStatus !== 'approved') {
      return res.status(403).json({ 
        error: 'Account not approved',
        approvalStatus: driver.approvalStatus 
      });
    }

    const orders = await Order.find({
      'assignments.driverId': driver._id,
      status: { $ne: 'completed' }
    }).sort({ createdAt: -1 });

    res.json(orders);
  } catch (error) {
    console.error('Get driver assignments error:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

app.post('/driver/update-assignment-status', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { orderId, status } = req.body;

    if (!orderId || !status) {
      return res.status(400).json({ error: 'Order ID and status are required' });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    if (!driver || driver.approvalStatus !== 'approved') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const assignment = order.assignments.find(
      a => a.driverId.toString() === driver._id.toString()
    );

    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    assignment.status = status;
    
    if (status === 'in_transit' && !assignment.startedAt) {
      assignment.startedAt = new Date();
    } else if (status === 'completed') {
      assignment.completedAt = new Date();
      driver.stats.completedRides += 1;
      await driver.save();
    }

    // Check if all assignments are completed
    const allCompleted = order.assignments.every(a => a.status === 'completed');
    if (allCompleted) {
      order.status = 'completed';
      order.completedAt = new Date();
      
      const customer = await Customer.findById(order.customerId);
      if (customer) {
        customer.stats.completedOrders += 1;
        await customer.save();
      }
    } else if (status === 'in_transit' && order.status !== 'in_transit') {
      order.status = 'in_transit';
    }

    await order.save();

    // Notify customer and admin
    const customer = await Customer.findById(order.customerId);
    if (customer) {
      await new Notification({
        userId: customer.userId,
        title: 'Order Update',
        message: `Driver ${driver.name} updated status to ${status}`,
        type: 'status',
        orderId: order._id
      }).save();

      emitToUser(customer.userId, 'order:status_updated', {
        orderId: order._id,
        status: order.status
      });
    }

    emitToAdmins('order:status_updated', {
      orderId: order._id,
      status: order.status
    });

    res.json({
      message: 'Assignment status updated',
      order
    });

  } catch (error) {
    console.error('Update assignment status error:', error);
    res.status(500).json({ error: 'Status update failed' });
  }
});

// ==================== CUSTOMER ENDPOINTS ====================

app.post('/orders/create', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'customer') {
      return res.status(403).json({ error: "Access denied" });
    }

    const customer = await Customer.findOne({ userId: req.userId });
    if (!customer) {
      return res.status(404).json({ error: "Customer profile not found" });
    }

    const { pickupLocation, dropLocation, pickupDateTime, vehicleCount } = req.body;

    if (!pickupLocation || !dropLocation || !pickupDateTime || !vehicleCount) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const newOrder = new Order({
      customerId: customer._id,
      customerName: customer.name,
      customerEmail: customer.email,
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
    const user = await User.findById(req.userId).select('-password');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let roleData = null;
    if (user.role === 'customer') {
      roleData = await Customer.findOne({ userId: user._id });
    } else if (user.role === 'driver') {
      roleData = await Driver.findOne({ userId: user._id });
    }

    res.json({
      user,
      roleData,
    });
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

app.put('/driver/profile', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const driver = await Driver.findOneAndUpdate(
      { userId: req.userId },
      { $set: req.body },
      { new: true, runValidators: true }
    );

    res.json(driver);
  } catch (error) {
    console.error('Driver update error:', error);
    res.status(500).json({ error: 'Update failed' });
  }
});

app.put('/customer/profile', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'customer') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const customer = await Customer.findOneAndUpdate(
      { userId: req.userId },
      { $set: req.body },
      { new: true, runValidators: true }
    );

    res.json(customer);
  } catch (error) {
    console.error('Customer update error:', error);
    res.status(500).json({ error: 'Update failed' });
  }
});

app.get('/admin/drivers', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const drivers = await Driver.find({ approvalStatus: 'approved' }).populate('userId', 'name email');
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

    const customers = await Customer.find().populate('userId', 'name email');
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

app.post("/customer-intent", async (req, res) => {
  try {
    const { name, phone, email, message } = req.body;

    if (!name || !phone || !email) {
      return res.status(400).send("Missing required fields");
    }

    const intent = new CustomerIntent({
      name,
      phone,
      email,
      message
    });
    await intent.save();

    await sendAdminEmail(
      "📩 New Customer Intent | Drivetics",
      `
A new customer showed interest via website.

Name: ${name}
Phone: ${phone}
Email: ${email}

Message:
${message || "No additional message"}
      `
    );

    const admins = await User.find({ role: "admin" });
    for (let admin of admins) {
      await new Notification({
        userId: admin._id,
        title: "New Customer Intent",
        message: `${name} submitted a pickup request`,
        type: "order"
      }).save();
    }

    emitToAdmins('customer_intent:new', {
      name,
      phone,
      email,
      message
    });

    res.json({ success: true });

  } catch (err) {
    console.error("CUSTOMER INTENT ERROR:", err.message);
    res.status(500).send("Something went wrong. Please try again later.");
  }
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket server is ready`);
  console.log(`Uploads directory: ${uploadsDir}`);
  console.log('\n🔐 Authentication Endpoints:');
  console.log('  POST /register - Manual registration');
  console.log('  POST /login - Manual login');
  console.log('  POST /google-login - Google sign-in');
  console.log('  POST /google-signup - Google sign-up (customer/admin)');
  console.log('  POST /google-driver-signup - Google driver sign-up with photo');
  console.log('  GET  /verify-token - Verify JWT token\n');
  console.log('👮 Admin Endpoints:');
  console.log('  GET  /admin/pending-drivers - Get pending driver approvals');
  console.log('  POST /admin/approve-driver/:driverId - Approve driver');
  console.log('  POST /admin/reject-driver/:driverId - Reject driver\n');
});