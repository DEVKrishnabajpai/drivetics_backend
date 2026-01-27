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

const app = express();

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
    // Accept images only
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

// USERS SCHEMA - For fast authentication and indexing
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, unique: true, required: true, index: true },
  password: { type: String }, // Optional for Google auth users
  role: { type: String, enum: ['admin', 'customer', 'driver'], required: true, index: true },
  googleId: { type: String, unique: true, sparse: true, index: true },
  photoUrl: { type: String },
  authProvider: { type: String, enum: ['local', 'google'], default: 'local' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", UserSchema);

// DRIVER SCHEMA - Detailed driver information
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

// CUSTOMER SCHEMA - Detailed customer information
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

// ORDER SCHEMA - Updated with live location tracking
const OrderSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
  customerName: { type: String, required: true },
  customerEmail: { type: String, required: true },
  pickupLocation: { type: String, required: true },
  dropLocation: { type: String, required: true },
  pickupDateTime: { type: Date, required: true },
  vehicleCount: { type: Number, required: true },
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

// NOTIFICATION SCHEMA
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

// CUSTOMER INTENT SCHEMA
const CustomerIntentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String, required: true },
  message: { type: String },
  createdAt: { type: Date, default: Date.now }
});

const CustomerIntent = mongoose.model("customer_intent", CustomerIntentSchema);

// ==================== HELPER FUNCTIONS ====================

// Create user in both Users and role-specific collections
async function createUserWithRole(userData) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 1. Create in main Users collection
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

    // 2. Create in role-specific collection
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

// ==================== CRON JOB - Auto deactivate drivers ====================
setInterval(async () => {
  try {
    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000);
    
    // Find active drivers with no assignments in last 10 hours
    const activeDrivers = await Driver.find({ isActive: true });
    
    for (let driver of activeDrivers) {
      const recentOrder = await Order.findOne({
        'assignments.driverId': driver._id,
        'assignments.assignedAt': { $gte: tenHoursAgo }
      });
      
      if (!recentOrder) {
        driver.isActive = false;
        await driver.save();
        
        // Notify driver
        await new Notification({
          userId: driver.userId,
          title: "Auto Deactivated",
          message: "You've been automatically deactivated due to inactivity. Please reactivate when available.",
          type: 'status'
        }).save();
      }
    }
  } catch (err) {
    console.error("Auto-deactivation error:", err);
  }
}, 60 * 60 * 1000); // Run every hour

// ==================== AUTH ROUTES ====================

// REGISTER
app.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: "All fields required" });
    }
    
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: "User already exists" });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const newUser = await createUserWithRole({
      name,
      email,
      password: hashedPassword,
      role
    });
    
    const token = jwt.sign(
      { userId: newUser._id, role: newUser.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    res.status(201).json({
      message: "User registered successfully",
      token,
      user: {
        id: newUser._id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role
      }
    });
  } catch (err) {
    console.error("REGISTER ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// LOGIN
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: "Invalid credentials" });
    }
    
    if (user.authProvider === 'google') {
      return res.status(400).json({ 
        error: "This email is registered with Google. Please use Google Sign-In" 
      });
    }
    
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid credentials" });
    }
    
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    res.json({
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
    console.error("LOGIN ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// GOOGLE SIGN-IN
app.post('/google-signin', async (req, res) => {
  try {
    const { idToken, role, platform = 'android' } = req.body;
    
    if (!idToken || !role) {
      return res.status(400).json({ error: "ID token and role required" });
    }

    let ticket;
    let payload;
    
    // Try each platform's client
    const clientsToTry = [
      googleClients[platform],
      googleClients.android,
      googleClients.ios,
      googleClients.web
    ];

    for (const client of clientsToTry) {
      try {
        ticket = await client.verifyIdToken({
          idToken,
          audience: client._clientId
        });
        payload = ticket.getPayload();
        break;
      } catch (err) {
        continue;
      }
    }

    if (!payload) {
      return res.status(401).json({ error: "Invalid Google token" });
    }

    const { sub: googleId, email, name, picture } = payload;
    
    let user = await User.findOne({ email });
    
    if (user) {
      if (user.authProvider === 'local') {
        return res.status(400).json({ 
          error: "This email is registered with password. Please use email/password login" 
        });
      }
      
      if (user.role !== role) {
        return res.status(400).json({ 
          error: `This email is registered as ${user.role}. Please sign in with correct role.` 
        });
      }
    } else {
      user = await createUserWithRole({
        name,
        email,
        googleId,
        photoUrl: picture,
        role,
        authProvider: 'google'
      });
    }
    
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    res.json({
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
    console.error("GOOGLE SIGNIN ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== DRIVER ROUTES ====================

// UPLOAD PROFILE PHOTO - FIXED VERSION
app.post('/driver/upload-profile', authMiddleware, (req, res) => {
  // Use multer middleware
  upload.single('photo')(req, res, async (err) => {
    try {
      // Check for multer errors
      if (err instanceof multer.MulterError) {
        console.error('Multer error:', err);
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File too large. Maximum size is 10MB' });
        }
        return res.status(400).json({ error: `Upload error: ${err.message}` });
      } else if (err) {
        console.error('Upload error:', err);
        return res.status(400).json({ error: err.message });
      }

      // Check if user is a driver
      if (req.userRole !== 'driver') {
        return res.status(403).json({ error: "Only drivers can upload profile photos" });
      }

      // Check if file was uploaded
      if (!req.file) {
        console.error('No file in request');
        return res.status(400).json({ error: "No photo file uploaded. Please select a photo." });
      }

      // Find driver
      const driver = await Driver.findOne({ userId: req.userId });
      if (!driver) {
        // Clean up uploaded file if driver not found
        if (req.file && req.file.path) {
          fs.unlinkSync(req.file.path);
        }
        return res.status(404).json({ error: "Driver not found" });
      }

      // Delete old profile photo if exists
      if (driver.profilePhoto) {
        const oldPhotoPath = path.join(__dirname, 'uploads', driver.profilePhoto);
        if (fs.existsSync(oldPhotoPath)) {
          fs.unlinkSync(oldPhotoPath);
        }
      }

      // Update driver profile
      driver.profilePhoto = req.file.filename;
      driver.isApproved = true; // Auto-approve after photo upload
      await driver.save();

      console.log('Profile photo uploaded successfully:', req.file.filename);

      res.json({ 
        message: "Profile photo uploaded successfully",
        profilePhoto: driver.profilePhoto,
        isApproved: true,
        photoUrl: `/uploads/${driver.profilePhoto}`
      });
    } catch (error) {
      console.error('Server error during profile upload:', error);
      // Clean up uploaded file on error
      if (req.file && req.file.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (unlinkErr) {
          console.error('Error deleting file:', unlinkErr);
        }
      }
      res.status(500).json({ error: "Server error during upload" });
    }
  });
});

// GET DRIVER PROFILE STATUS
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
      hasProfilePhoto: !!driver.profilePhoto,
      isApproved: driver.isApproved,
      isActive: driver.isActive,
      canActivate: driver.isApproved && driver.profilePhoto,
      profilePhoto: driver.profilePhoto ? `/uploads/${driver.profilePhoto}` : null
    });
  } catch (err) {
    console.error('Profile status error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// TOGGLE DRIVER STATUS
app.put('/driver/toggle-status', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    if (!driver.profilePhoto || !driver.isApproved) {
      return res.status(400).json({ 
        error: "Please upload your profile photo first to activate your account" 
      });
    }

    driver.isActive = !driver.isActive;
    driver.lastActiveAt = new Date();
    await driver.save();

    res.json({ 
      message: driver.isActive ? "You are now active" : "You are now inactive",
      isActive: driver.isActive 
    });
  } catch (err) {
    console.error('Toggle status error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// UPDATE DRIVER LOCATION
app.post('/driver/update-location', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    const { latitude, longitude } = req.body;
    
    if (!latitude || !longitude) {
      return res.status(400).json({ error: "Latitude and longitude required" });
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
    driver.lastActiveAt = new Date();
    await driver.save();

    // Update location in active orders
    await Order.updateMany(
      { 
        'assignments.driverId': driver._id,
        status: { $in: ['assigned', 'in_transit'] }
      },
      { 
        $set: { 
          'assignments.$[elem].currentLocation': {
            latitude,
            longitude,
            updatedAt: new Date()
          }
        }
      },
      {
        arrayFilters: [{ 'elem.driverId': driver._id }]
      }
    );

    res.json({ message: "Location updated" });
  } catch (err) {
    console.error('Location update error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET DRIVER DASHBOARD
app.get('/driver/dashboard', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    // Get active orders
    const activeOrders = await Order.find({
      'assignments.driverId': driver._id,
      status: { $ne: 'completed' }
    }).sort({ createdAt: -1 });

    res.json({
      stats: driver.stats,
      activeOrders,
      profileStatus: {
        hasProfilePhoto: !!driver.profilePhoto,
        isApproved: driver.isApproved,
        isActive: driver.isActive,
        profilePhoto: driver.profilePhoto ? `/uploads/${driver.profilePhoto}` : null
      }
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// APPROVE DRIVER (Admin)
app.put('/admin/drivers/:driverId/approve', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: "Access denied" });
    }

    const driver = await Driver.findById(req.params.driverId);
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    driver.isApproved = true;
    await driver.save();

    // Notify driver
    await new Notification({
      userId: driver.userId,
      title: "Account Approved",
      message: "Your driver account has been approved! You can now activate your status.",
      type: 'status'
    }).save();

    res.json({ message: "Driver approved", driver });
  } catch (err) {
    console.error('Approve driver error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== ORDER ROUTES ====================

// CREATE ORDER (Customer)
app.post('/orders', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'customer') {
      return res.status(403).json({ error: "Only customers can create orders" });
    }

    const { pickupLocation, dropLocation, pickupDateTime, vehicleCount } = req.body;

    const customer = await Customer.findOne({ userId: req.userId });
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }
    
    const order = new Order({
      customerId: customer._id,
      customerName: customer.name,
      customerEmail: customer.email,
      pickupLocation,
      dropLocation,
      pickupDateTime,
      vehicleCount
    });

    await order.save();

    // Update customer stats
    customer.stats.totalOrders += 1;
    await customer.save();

    await sendAdminEmail(
      "🚚 New Ride Booked | Drivetics",
      `
New ride has been booked.

Customer Name: ${customer.name}
Customer Email: ${customer.email}

Pickup Location: ${pickupLocation}
Drop Location: ${dropLocation}
Pickup Time: ${pickupDateTime}
Number of Vehicles: ${vehicleCount}

Please log in to the admin panel to assign drivers.
`
    );

    // Create notification for all admins
    const admins = await User.find({ role: 'admin' });
    for (let admin of admins) {
      await new Notification({
        userId: admin._id,
        title: "New Order Received",
        message: `${customer.name} requested transport for ${vehicleCount} vehicles`,
        type: 'order',
        orderId: order._id
      }).save();
    }

    res.status(201).json({
      message: "Order created successfully",
      orderId: order._id
    });
  } catch (err) {
    console.error("ORDER ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// GET ORDERS
app.get('/orders', authMiddleware, async (req, res) => {
  try {
    let query = {};
    
    if (req.userRole === 'customer') {
      const customer = await Customer.findOne({ userId: req.userId });
      query.customerId = customer._id;
      query.status = { $ne: 'completed' }; // Only active orders
    } else if (req.userRole === 'driver') {
      const driver = await Driver.findOne({ userId: req.userId });
      query['assignments.driverId'] = driver._id;
      query.status = { $ne: 'completed' }; // Only active orders
    }

    const { status } = req.query;
    if (status && req.userRole === 'admin') {
      query.status = status;
    }

    const orders = await Order.find(query).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    console.error('Get orders error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET ORDER HISTORY (Completed orders)
app.get('/orders/history', authMiddleware, async (req, res) => {
  try {
    let query = { status: 'completed' };
    
    if (req.userRole === 'customer') {
      const customer = await Customer.findOne({ userId: req.userId });
      query.customerId = customer._id;
    } else if (req.userRole === 'driver') {
      const driver = await Driver.findOne({ userId: req.userId });
      query['assignments.driverId'] = driver._id;
    }

    const orders = await Order.find(query).sort({ completedAt: -1 });
    res.json(orders);
  } catch (err) {
    console.error('Get order history error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET SINGLE ORDER WITH LIVE TRACKING
app.get('/orders/:orderId/track', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await Order.findById(orderId);
    
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Check permissions
    if (req.userRole === 'customer') {
      const customer = await Customer.findOne({ userId: req.userId });
      if (order.customerId.toString() !== customer._id.toString()) {
        return res.status(403).json({ error: "Access denied" });
      }
    }

    res.json(order);
  } catch (err) {
    console.error('Track order error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// ASSIGN DRIVERS (Admin)
app.post('/orders/:orderId/assign', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: "Only admins can assign drivers" });
    }

    const { orderId } = req.params;
    const order = await Order.findById(orderId);
    
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Get active and approved drivers
    const activeDrivers = await Driver.find({ 
      isActive: true,
      isApproved: true,
      profilePhoto: { $ne: null }
    }).limit(order.vehicleCount);
    
    if (activeDrivers.length < order.vehicleCount) {
      return res.status(400).json({ 
        error: `Not enough active drivers available. Need ${order.vehicleCount}, found ${activeDrivers.length}` 
      });
    }

    // Assign drivers
    order.assignments = activeDrivers.map(driver => ({
      driverId: driver._id,
      driverName: driver.name,
      status: 'assigned'
    }));
    order.status = 'assigned';
    await order.save();

    // Update driver stats and last active time
    for (let driver of activeDrivers) {
      driver.stats.totalRides += 1;
      driver.lastActiveAt = new Date();
      await driver.save();
    }

    // Create notifications for drivers
    for (let driver of activeDrivers) {
      await new Notification({
        userId: driver.userId,
        title: "New Assignment",
        message: `You've been assigned to transport from ${order.pickupLocation} to ${order.dropLocation}`,
        type: 'assignment',
        orderId: order._id
      }).save();
    }

    res.json({ message: "Drivers assigned successfully", order });
  } catch (err) {
    console.error('Assign drivers error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// UPLOAD VEHICLE IMAGES (Driver)
app.post('/orders/:orderId/upload-images', authMiddleware, (req, res) => {
  // Use multer for multiple images
  upload.array('images', 20)(req, res, async (err) => {
    try {
      // Check for multer errors
      if (err instanceof multer.MulterError) {
        console.error('Multer error:', err);
        return res.status(400).json({ error: `Upload error: ${err.message}` });
      } else if (err) {
        console.error('Upload error:', err);
        return res.status(400).json({ error: err.message });
      }

      if (req.userRole !== 'driver') {
        return res.status(403).json({ error: "Access denied" });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No images uploaded" });
      }

      if (req.files.length < 10) {
        // Delete uploaded files
        req.files.forEach(file => {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        });
        return res.status(400).json({ error: "Minimum 10 images required" });
      }

      const driver = await Driver.findOne({ userId: req.userId });
      if (!driver) {
        return res.status(404).json({ error: "Driver not found" });
      }

      const order = await Order.findById(req.params.orderId);
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      // Find driver's assignment
      const assignment = order.assignments.find(
        a => a.driverId.toString() === driver._id.toString()
      );

      if (!assignment) {
        return res.status(400).json({ error: "You are not assigned to this order" });
      }

      // Store filenames
      assignment.vehicleImages = req.files.map(file => file.filename);
      await order.save();

      res.json({ 
        message: "Images uploaded successfully",
        imageCount: req.files.length 
      });
    } catch (error) {
      console.error('Image upload error:', error);
      // Clean up uploaded files on error
      if (req.files) {
        req.files.forEach(file => {
          if (file.path && fs.existsSync(file.path)) {
            try {
              fs.unlinkSync(file.path);
            } catch (unlinkErr) {
              console.error('Error deleting file:', unlinkErr);
            }
          }
        });
      }
      res.status(500).json({ error: "Server error" });
    }
  });
});

// START RIDE (Driver)
app.put('/orders/:orderId/start', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Find driver's assignment
    const assignment = order.assignments.find(
      a => a.driverId.toString() === driver._id.toString()
    );

    if (!assignment) {
      return res.status(400).json({ error: "You are not assigned to this order" });
    }

    if (assignment.vehicleImages.length < 10) {
      return res.status(400).json({ error: "Please upload at least 10 vehicle images first" });
    }

    assignment.status = 'in_transit';
    assignment.startedAt = new Date();

    // Check if all drivers started
    const allStarted = order.assignments.every(a => a.status === 'in_transit' || a.status === 'completed');
    if (allStarted) {
      order.status = 'in_transit';
    }

    await order.save();

    // Notify customer
    const customer = await Customer.findById(order.customerId);
    if (customer) {
      await new Notification({
        userId: customer.userId,
        title: "Ride Started",
        message: `${driver.name} has started transporting your vehicle`,
        type: 'status',
        orderId: order._id
      }).save();
    }

    res.json({ message: "Ride started successfully" });
  } catch (err) {
    console.error('Start ride error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// COMPLETE RIDE (Driver)
app.put('/orders/:orderId/complete', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Find driver's assignment
    const assignment = order.assignments.find(
      a => a.driverId.toString() === driver._id.toString()
    );

    if (!assignment) {
      return res.status(400).json({ error: "You are not assigned to this order" });
    }

    if (assignment.status !== 'in_transit') {
      return res.status(400).json({ error: "Ride must be started first" });
    }

    assignment.status = 'completed';
    assignment.completedAt = new Date();

    // Check if all assignments completed
    const allCompleted = order.assignments.every(a => a.status === 'completed');
    if (allCompleted) {
      order.status = 'completed';
      order.completedAt = new Date();

      // Update customer stats
      const customer = await Customer.findById(order.customerId);
      if (customer) {
        customer.stats.completedOrders += 1;
        await customer.save();
      }
    }
    
    await order.save();

    // Update driver stats
    driver.stats.completedRides += 1;
    await driver.save();

    // Notify customer
    const customer = await Customer.findById(order.customerId);
    if (customer && allCompleted) {
      await new Notification({
        userId: customer.userId,
        title: "Order Completed",
        message: `Your order from ${order.pickupLocation} to ${order.dropLocation} has been completed`,
        type: 'status',
        orderId: order._id
      }).save();
    }

    res.json({ 
      message: "Ride completed successfully",
      orderCompleted: allCompleted 
    });
  } catch (err) {
    console.error('Complete ride error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== ADMIN ROUTES ====================

// GET ADMIN DASHBOARD
app.get('/admin/dashboard', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: "Access denied" });
    }

    const totalDrivers = await Driver.countDocuments();
    const activeDrivers = await Driver.countDocuments({ isActive: true, isApproved: true });
    const totalCustomers = await Customer.countDocuments();
    
    const pendingOrders = await Order.countDocuments({ status: 'pending' });
    const inTransitOrders = await Order.countDocuments({ status: 'in_transit' });
    const completedOrders = await Order.countDocuments({ status: 'completed' });

    const recentOrders = await Order.find().sort({ createdAt: -1 }).limit(10);
    const drivers = await Driver.find();

    res.json({
      totalDrivers,
      activeDrivers,
      totalCustomers,
      pendingOrders,
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

// GET ALL DRIVER LOCATIONS (Admin)
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

// GET USER PROFILE
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

// UPDATE DRIVER PROFILE
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

// UPDATE CUSTOMER PROFILE
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

// GET ALL DRIVERS (Admin)
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

// GET ALL CUSTOMERS (Admin)
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

    res.json({ success: true });

  } catch (err) {
    console.error("CUSTOMER INTENT ERROR:", err.message);
    res.status(500).send("Something went wrong. Please try again later.");
  }
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Uploads directory: ${uploadsDir}`);
});