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
  photoUrl: { type: String },
  authProvider: { type: String, enum: ['local', 'google'], default: 'local' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", UserSchema);

const DriverSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String, required: true },
  profilePhoto: { type: String, default: null },
  isActive: { type: Boolean, default: false },
  isApproved: { type: Boolean, default: false },
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

// ENHANCED ORDER SCHEMA with cost field
const OrderSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
  customerName: { type: String, required: true },
  customerEmail: { type: String, required: true },
  pickupLocation: { type: String, required: true },
  dropLocation: { type: String, required: true },
  pickupDateTime: { type: Date, required: true },
  vehicleCount: { type: Number, required: true },
  cost: { type: Number, default: null }, // Admin can set this
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
  type: { type: String, enum: ['order', 'assignment', 'status'], required: true },
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

// Store connected clients by userId and role
const connectedClients = new Map();

// WebSocket authentication middleware
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
  
  // Store client connection
  connectedClients.set(socket.userId, { socket, role: socket.userRole });
  
  // Join role-specific room
  socket.join(socket.userRole);
  
  // Handle driver status change
  socket.on('driver:status_change', async (data) => {
    try {
      const driver = await Driver.findOne({ userId: socket.userId });
      if (driver) {
        driver.isActive = data.isActive;
        driver.lastActiveAt = new Date();
        await driver.save();
        
        // Notify all admins
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
  
  // Handle driver location update
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
        
        // Update location in active orders
        await Order.updateMany(
          { 'assignments.driverId': driver._id, status: 'in_transit' },
          { 
            $set: { 
              'assignments.$.currentLocation': driver.currentLocation 
            } 
          }
        );
        
        // Notify admins and customers
        io.to('admin').emit('driver:location_updated', {
          driverId: driver._id,
          location: driver.currentLocation
        });
      }
    } catch (err) {
      console.error('Location update error:', err);
    }
  });
  
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.userId}`);
    connectedClients.delete(socket.userId);
  });
});

// Helper function to emit to specific user
function emitToUser(userId, event, data) {
  const client = connectedClients.get(userId.toString());
  if (client && client.socket) {
    client.socket.emit(event, data);
  }
}

// Helper function to emit to all admins
function emitToAdmins(event, data) {
  io.to('admin').emit(event, data);
}

// ==================== HELPER FUNCTIONS ====================

async function createUserWithRole(userData) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const newUser = new User({
      name: userData.name,
      email: userData.email,
      password: userData.password,
      role: userData.role,
      googleId: userData.googleId,
      photoUrl: userData.photoUrl,
      authProvider: userData.authProvider || 'local'
    });
    await newUser.save({ session });

    if (userData.role === 'driver') {
      const driver = new Driver({
        userId: newUser._id,
        name: newUser.name,
        email: newUser.email,
        profilePhoto: userData.photoUrl || null
      });
      await driver.save({ session });
    } else if (userData.role === 'customer') {
      const customer = new Customer({
        userId: newUser._id,
        name: newUser.name,
        email: newUser.email
      });
      await customer.save({ session });
    }

    await session.commitTransaction();
    return newUser;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}

// ==================== MIDDLEWARE ====================

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "No token provided" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

// ==================== AUTH ROUTES ====================

app.post("/register", async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: "Email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    
    const user = await createUserWithRole({
      name,
      email,
      password: hashedPassword,
      role,
      authProvider: 'local'
    });

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
      }
    });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: "Server error during registration" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (user.authProvider === 'google') {
      return res.status(400).json({ error: "Please sign in with Google" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { userId: user._id, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error during login" });
  }
});

app.post("/google-auth", async (req, res) => {
  try {
    const { idToken, role, platform = 'android' } = req.body;

    if (!idToken || !role) {
      return res.status(400).json({ error: "Token and role are required" });
    }

    const client = googleClients[platform] || googleClients.android;
    const ticket = await client.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_IDS[platform]
    });

    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    let user = await User.findOne({ googleId });

    if (!user) {
      user = await User.findOne({ email });
      if (user && user.authProvider === 'local') {
        return res.status(400).json({ 
          error: "Email exists with password login. Please use password." 
        });
      }

      if (!user) {
        user = await createUserWithRole({
          name,
          email,
          role,
          googleId,
          photoUrl: picture,
          authProvider: 'google'
        });
      }
    }

    const token = jwt.sign(
      { userId: user._id, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Google authentication successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        photoUrl: user.photoUrl
      }
    });
  } catch (err) {
    console.error("Google auth error:", err);
    res.status(500).json({ error: "Google authentication failed" });
  }
});

// ==================== DRIVER ROUTES ====================

app.get('/driver/profile', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    if (!driver) {
      return res.status(404).json({ error: "Driver profile not found" });
    }

    res.json(driver);
  } catch (err) {
    console.error('Get driver profile error:', err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==================== DRIVER DASHBOARD ENDPOINTS - ADD THESE TO YOUR SERVER ====================
// Add these endpoints after line 539 (after app.get('/driver/profile'))

// GET DRIVER DASHBOARD DATA
app.get('/driver/dashboard', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    // Get active assignments
    const activeAssignments = await Order.find({
      'assignments.driverId': driver._id,
      status: { $in: ['assigned', 'in_transit'] }
    }).sort({ pickupDateTime: 1 });

    // Get completed rides count
    const completedRides = await Order.countDocuments({
      'assignments.driverId': driver._id,
      'assignments.status': 'completed'
    });

    // Get total earnings (if cost is tracked)
    const completedOrders = await Order.find({
      'assignments.driverId': driver._id,
      status: 'completed',
      cost: { $exists: true, $ne: null }
    });

    const totalEarnings = completedOrders.reduce((sum, order) => {
      // Assuming each driver gets an equal share
      const driverCount = order.assignments.length;
      return sum + (order.cost / driverCount);
    }, 0);

    res.json({
      profileStatus: {
        hasProfilePhoto: driver.profilePhoto ? true : false,
        isApproved: driver.isApproved,
        isActive: driver.isActive
      },
      stats: {
        activeRides: activeAssignments.length,
        completedRides: driver.stats.completedRides || completedRides,
        totalEarnings: Math.round(totalEarnings * 100) / 100
      },
      activeAssignments: activeAssignments,
      driver: {
        name: driver.name,
        email: driver.email,
        isActive: driver.isActive,
        isApproved: driver.isApproved,
        profilePhoto: driver.profilePhoto
      }
    });
  } catch (err) {
    console.error('Driver dashboard error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET DRIVER PROFILE STATUS (for quick checks)
app.get('/driver/profile-status', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    res.json({
      hasProfilePhoto: driver.profilePhoto ? true : false,
      isApproved: driver.isApproved,
      isActive: driver.isActive
    });
  } catch (err) {
    console.error('Get profile status error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// UPLOAD PROFILE PHOTO
app.post('/driver/upload-profile', authMiddleware, upload.single('profilePhoto'), async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    // Delete old profile photo if exists
    if (driver.profilePhoto) {
      const oldPhotoPath = path.join(__dirname, driver.profilePhoto.replace(/^\//, ''));
      if (fs.existsSync(oldPhotoPath)) {
        fs.unlinkSync(oldPhotoPath);
      }
    }

    // Save new profile photo path
    driver.profilePhoto = `/uploads/${req.file.filename}`;
    await driver.save();

    res.json({
      message: "Profile photo uploaded successfully",
      profilePhoto: driver.profilePhoto
    });
  } catch (err) {
    console.error('Upload profile photo error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// FIX THE TOGGLE STATUS ENDPOINT - Replace the existing one
app.put('/driver/toggle-status', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    // Check if profile photo is uploaded and driver is approved
    if (!driver.profilePhoto) {
      return res.status(400).json({ 
        error: "Please upload your profile photo first" 
      });
    }

    if (!driver.isApproved) {
      return res.status(400).json({ 
        error: "Your profile is pending approval" 
      });
    }

    driver.isActive = !driver.isActive;
    driver.lastActiveAt = new Date();
    await driver.save();

    res.json({ 
      message: `Status changed to ${driver.isActive ? 'active' : 'inactive'}`,
      isActive: driver.isActive
    });
  } catch (err) {
    console.error('Toggle status error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// COMPLETE RIDE WITH IMAGES
app.post('/driver/complete-ride/:orderId', authMiddleware, upload.array('vehicleImages', 5), async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    const order = await Order.findById(req.params.orderId);

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const assignment = order.assignments.find(
      a => a.driverId.toString() === driver._id.toString()
    );

    if (!assignment) {
      return res.status(404).json({ error: "Assignment not found" });
    }

    assignment.status = 'completed';
    assignment.completedAt = new Date();
    
    if (req.files && req.files.length > 0) {
      assignment.vehicleImages = req.files.map(f => `/uploads/${f.filename}`);
    }

    const allCompleted = order.assignments.every(a => a.status === 'completed');
    if (allCompleted) {
      order.status = 'completed';
      order.completedAt = new Date();
      
      driver.stats.completedRides += 1;
      await driver.save();

      const customer = await Customer.findById(order.customerId);
      if (customer) {
        customer.stats.completedOrders += 1;
        await customer.save();
      }
    }

    await order.save();

    res.json({ 
      message: "Ride completed successfully",
      orderCompleted: allCompleted 
    });
  } catch (err) {
    console.error('Complete ride error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// UPLOAD ORDER IMAGES (separate endpoint for uploading images)
app.post('/orders/:orderId/upload-images', authMiddleware, upload.array('images', 20), async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    const order = await Order.findById(req.params.orderId);

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const assignment = order.assignments.find(
      a => a.driverId.toString() === driver._id.toString()
    );

    if (!assignment) {
      return res.status(404).json({ error: "Assignment not found" });
    }

    if (req.files && req.files.length > 0) {
      assignment.vehicleImages = req.files.map(f => `/uploads/${f.filename}`);
      await order.save();
      
      res.json({ 
        message: "Images uploaded successfully",
        imageCount: req.files.length
      });
    } else {
      res.status(400).json({ error: "No images uploaded" });
    }
  } catch (err) {
    console.error('Upload images error:', err);
    res.status(500).json({ error: "Server error" });
  }
});
app.post('/driver/toggle-status', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    driver.isActive = !driver.isActive;
    driver.lastActiveAt = new Date();
    await driver.save();

    // Emit real-time update to admins
    emitToAdmins('driver:status_updated', {
      driverId: driver._id,
      name: driver.name,
      email: driver.email,
      isActive: driver.isActive
    });

    res.json({ 
      message: `Status changed to ${driver.isActive ? 'active' : 'inactive'}`,
      isActive: driver.isActive
    });
  } catch (err) {
    console.error('Toggle status error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post('/driver/update-location', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    const { latitude, longitude } = req.body;
    if (!latitude || !longitude) {
      return res.status(400).json({ error: "Location coordinates required" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    driver.currentLocation = {
      latitude,
      longitude,
      updatedAt: new Date()
    };
    await driver.save();

    // Update location in active assignments
    await Order.updateMany(
      { 'assignments.driverId': driver._id, status: { $in: ['assigned', 'in_transit'] } },
      { 
        $set: { 
          'assignments.$.currentLocation': driver.currentLocation 
        } 
      }
    );

    // Emit location update to admins
    emitToAdmins('driver:location_updated', {
      driverId: driver._id,
      name: driver.name,
      location: driver.currentLocation
    });

    res.json({ message: "Location updated successfully" });
  } catch (err) {
    console.error('Update location error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get('/driver/assignments', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    const orders = await Order.find({
      'assignments.driverId': driver._id,
      status: { $in: ['assigned', 'in_transit'] }
    }).sort({ pickupDateTime: 1 });

    res.json(orders);
  } catch (err) {
    console.error('Get assignments error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post('/driver/start-ride/:orderId', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    const order = await Order.findById(req.params.orderId);

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const assignment = order.assignments.find(
      a => a.driverId.toString() === driver._id.toString()
    );

    if (!assignment) {
      return res.status(404).json({ error: "Assignment not found" });
    }

    assignment.status = 'in_transit';
    assignment.startedAt = new Date();
    order.status = 'in_transit';

    await order.save();

    // Notify customer and admin
    const customer = await Customer.findById(order.customerId);
    if (customer) {
      await new Notification({
        userId: customer.userId,
        title: "Ride Started",
        message: `${driver.name} has started your ride`,
        type: 'status',
        orderId: order._id
      }).save();

      emitToUser(customer.userId, 'order:status_updated', {
        orderId: order._id,
        status: 'in_transit',
        message: 'Your ride has started'
      });
    }

    emitToAdmins('order:status_updated', {
      orderId: order._id,
      status: 'in_transit',
      driverName: driver.name
    });

    res.json({ message: "Ride started successfully" });
  } catch (err) {
    console.error('Start ride error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post('/driver/complete-ride/:orderId', authMiddleware, upload.array('vehicleImages', 5), async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    const order = await Order.findById(req.params.orderId);

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const assignment = order.assignments.find(
      a => a.driverId.toString() === driver._id.toString()
    );

    if (!assignment) {
      return res.status(404).json({ error: "Assignment not found" });
    }

    assignment.status = 'completed';
    assignment.completedAt = new Date();
    
    if (req.files && req.files.length > 0) {
      assignment.vehicleImages = req.files.map(f => `/uploads/${f.filename}`);
    }

    const allCompleted = order.assignments.every(a => a.status === 'completed');
    if (allCompleted) {
      order.status = 'completed';
      order.completedAt = new Date();
      
      driver.stats.completedRides += 1;
      await driver.save();

      const customer = await Customer.findById(order.customerId);
      if (customer) {
        customer.stats.completedOrders += 1;
        await customer.save();
      }
    }

    await order.save();

    // Notify customer
    const customer = await Customer.findById(order.customerId);
    if (customer) {
      await new Notification({
        userId: customer.userId,
        title: allCompleted ? "Order Completed" : "Delivery Update",
        message: allCompleted 
          ? `Your order has been completed!`
          : `${driver.name} has completed their delivery`,
        type: 'status',
        orderId: order._id
      }).save();

      emitToUser(customer.userId, 'order:status_updated', {
        orderId: order._id,
        status: allCompleted ? 'completed' : 'in_transit',
        message: allCompleted ? 'Order completed!' : 'Partial delivery completed'
      });
    }

    emitToAdmins('order:status_updated', {
      orderId: order._id,
      status: allCompleted ? 'completed' : 'in_transit',
      driverName: driver.name,
      allCompleted
    });

    res.json({ 
      message: "Ride completed successfully",
      orderCompleted: allCompleted 
    });
  } catch (err) {
    console.error('Complete ride error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== CUSTOMER ROUTES ====================

app.post('/orders', authMiddleware, async (req, res) => {
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

    // Notify all admins
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

    // Emit real-time notification to admins
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

// ==================== ADMIN ROUTES ====================

app.get('/admin/dashboard', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: "Access denied" });
    }

    const totalDrivers = await Driver.countDocuments();
    const activeDrivers = await Driver.countDocuments({ isActive: true, isApproved: true });
    const totalCustomers = await Customer.countDocuments();
    
    const pendingOrders = await Order.countDocuments({ status: 'pending' });
    const assignedOrders = await Order.countDocuments({ status: 'assigned' });
    const inTransitOrders = await Order.countDocuments({ status: 'in_transit' });
    const completedOrders = await Order.countDocuments({ status: 'completed' });

    const recentOrders = await Order.find().sort({ createdAt: -1 }).limit(10);
    const drivers = await Driver.find();

    res.json({
      totalDrivers,
      activeDrivers,
      totalCustomers,
      pendingOrders,
      assignedOrders,
      inTransitOrders,
      completedOrders,
      recentOrders,
      drivers
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// Get orders with filtering and sorting
app.get('/admin/orders', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: "Access denied" });
    }

    const { status, sortBy = 'newest' } = req.query;
    
    let query = {};
    if (status && status !== 'all') {
      query.status = status;
    }

    let sortOptions = {};
    switch (sortBy) {
      case 'newest':
        sortOptions = { createdAt: -1 };
        break;
      case 'oldest':
        sortOptions = { createdAt: 1 };
        break;
      case 'nearest':
        sortOptions = { pickupDateTime: 1 };
        break;
      case 'farthest':
        sortOptions = { pickupDateTime: -1 };
        break;
      default:
        sortOptions = { createdAt: -1 };
    }

    const orders = await Order.find(query).sort(sortOptions);
    res.json(orders);
  } catch (err) {
    console.error('Get orders error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// Get single order details
app.get('/admin/orders/:id', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: "Access denied" });
    }

    const order = await Order.findById(req.params.id)
      .populate('customerId', 'name email phone')
      .populate('assignments.driverId', 'name email');

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json(order);
  } catch (err) {
    console.error('Get order details error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// Set order cost (admin only)
app.put('/admin/orders/:id/cost', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: "Access denied" });
    }

    const { cost } = req.body;
    if (!cost || cost <= 0) {
      return res.status(400).json({ error: "Valid cost required" });
    }

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { cost: parseFloat(cost) },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Notify customer
    const customer = await Customer.findById(order.customerId);
    if (customer) {
      await new Notification({
        userId: customer.userId,
        title: "Order Cost Updated",
        message: `The cost for your order has been set to $${cost}`,
        type: 'order',
        orderId: order._id
      }).save();

      emitToUser(customer.userId, 'order:cost_updated', {
        orderId: order._id,
        cost: cost
      });
    }

    // Emit update to other admins
    emitToAdmins('order:cost_updated', {
      orderId: order._id,
      cost: cost
    });

    res.json({ 
      message: "Cost updated successfully",
      order 
    });
  } catch (err) {
    console.error('Update cost error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// Assign drivers to order
app.post('/orders/:id/assign', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: "Access denied" });
    }

    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (order.status !== 'pending') {
      return res.status(400).json({ error: "Order already assigned" });
    }

    const activeDrivers = await Driver.find({ 
      isActive: true, 
      isApproved: true 
    }).limit(order.vehicleCount);

    if (activeDrivers.length < order.vehicleCount) {
      return res.status(400).json({ 
        error: `Not enough active drivers. Need ${order.vehicleCount}, found ${activeDrivers.length}` 
      });
    }

    order.assignments = activeDrivers.map(driver => ({
      driverId: driver._id,
      driverName: driver.name,
      status: 'assigned',
      assignedAt: new Date()
    }));

    order.status = 'assigned';
    await order.save();

    // Notify each driver
    for (let driver of activeDrivers) {
      await new Notification({
        userId: driver.userId,
        title: "New Assignment",
        message: `You've been assigned to a delivery`,
        type: 'assignment',
        orderId: order._id
      }).save();

      driver.stats.totalRides += 1;
      await driver.save();

      emitToUser(driver.userId, 'assignment:new', {
        orderId: order._id,
        order: order
      });
    }

    // Notify customer
    const customer = await Customer.findById(order.customerId);
    if (customer) {
      await new Notification({
        userId: customer.userId,
        title: "Drivers Assigned",
        message: `Drivers have been assigned to your order`,
        type: 'status',
        orderId: order._id
      }).save();

      emitToUser(customer.userId, 'order:status_updated', {
        orderId: order._id,
        status: 'assigned'
      });
    }

    // Emit to all admins
    emitToAdmins('order:assigned', {
      orderId: order._id,
      driversAssigned: activeDrivers.length
    });

    res.json({ 
      message: "Drivers assigned successfully",
      order 
    });
  } catch (err) {
    console.error('Assign drivers error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get('/admin/driver-locations', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: "Access denied" });
    }

    const drivers = await Driver.find({ 
      isActive: true,
      'currentLocation.latitude': { $exists: true }
    }).select('name email currentLocation isActive');

    res.json(drivers);
  } catch (err) {
    console.error('Get driver locations error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== USER PROFILE ROUTES ====================

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

    const drivers = await Driver.find().populate('userId', 'name email');
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

// ==================== NOTIFICATIONS ====================

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

// ==================== CUSTOMER INTENT ====================

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
});