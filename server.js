require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
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

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

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
          message: "You've been automatically deactivated due to 10 hours of inactivity",
          type: 'status'
        }).save();
      }
    }
  } catch (err) {
    console.error("Auto-deactivation error:", err);
  }
}, 60 * 60 * 1000); // Run every hour

// ==================== AUTHENTICATION ROUTES ====================

// REGISTER - Traditional Email/Password
app.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (!['admin', 'customer', 'driver'].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: "Email already exists" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user in both collections
    const newUser = await createUserWithRole({
      name,
      email,
      password: hashedPassword,
      role,
      authProvider: 'local'
    });

    // Generate JWT
    const token = jwt.sign(
      { userId: newUser._id, role: newUser.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.status(201).json({
      message: "User Registered Successfully",
      token,
      role: newUser.role,
      userId: newUser._id,
      name: newUser.name
    });
  } catch (err) {
    console.error("REGISTER ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// LOGIN - Traditional Email/Password
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Fast indexed search in Users collection
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    // Check if user registered with Google
    if (user.authProvider === 'google' && !user.password) {
      return res.status(400).json({ 
        error: "This account uses Google Sign-In. Please sign in with Google." 
      });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ 
      token, 
      role: user.role,
      userId: user._id,
      name: user.name
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GOOGLE SIGN-IN (Login)
app.post('/google-login', async (req, res) => {
  try {
    const { idToken, email, name, photoUrl, platform } = req.body; // platform: 'web', 'android', or 'ios'

    // Determine which platform client to use
    const platformType = platform || 'android'; // default to android
    const googleClient = googleClients[platformType];
    const clientId = GOOGLE_CLIENT_IDS[platformType];

    if (!googleClient || !clientId) {
      return res.status(400).json({ 
        error: 'Invalid platform specified. Use: web, android, or ios' 
      });
    }

    // Verify Google token with appropriate client
    let googleId;
    let verifiedEmail = email;
    
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: clientId,
      });
      const payload = ticket.getPayload();
      googleId = payload.sub;
      verifiedEmail = payload.email || email;
      
      console.log(`✅ Google token verified for ${platformType} platform`);
      
    } catch (verifyError) {
      console.error(`Token verification failed for ${platformType}:`, verifyError.message);
      // Continue with email-based lookup even if verification fails
    }

    // Check if user exists (indexed search by email or googleId)
    let user = await User.findOne({ 
      $or: [
        { email: verifiedEmail },
        ...(googleId ? [{ googleId }] : [])
      ]
    });

    if (!user) {
      return res.status(404).json({ 
        error: 'Account not found. Please register first.',
        needsRegistration: true 
      });
    }

    // Update Google ID and photo if not set
    if (googleId && !user.googleId) {
      user.googleId = googleId;
      user.photoUrl = photoUrl;
      user.authProvider = 'google';
      await user.save();
      
      // Update profile photo in role-specific collection
      if (user.role === 'driver') {
        await Driver.findOneAndUpdate(
          { userId: user._id },
          { profilePhoto: photoUrl }
        );
      }
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      userId: user._id,
      name: user.name,
      role: user.role,
    });

  } catch (error) {
    console.error('Google login error:', error);
    res.status(500).json({ error: 'Google login failed' });
  }
});

// GOOGLE SIGN-UP (Register)
app.post('/google-register', async (req, res) => {
  try {
    const { idToken, email, name, photoUrl, role, platform } = req.body;

    if (!role || !['admin', 'customer', 'driver'].includes(role)) {
      return res.status(400).json({ error: 'Valid role is required (customer, driver, or admin)' });
    }

    // Determine which platform client to use
    const platformType = platform || 'android'; // default to android
    const googleClient = googleClients[platformType];
    const clientId = GOOGLE_CLIENT_IDS[platformType];

    if (!googleClient || !clientId) {
      return res.status(400).json({ 
        error: 'Invalid platform specified. Use: web, android, or ios' 
      });
    }

    // Verify Google token with appropriate client
    let googleId;
    let verifiedEmail = email;
    
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: clientId,
      });
      const payload = ticket.getPayload();
      googleId = payload.sub;
      verifiedEmail = payload.email || email;
      
      console.log(`✅ Google token verified for ${platformType} platform`);
      
    } catch (verifyError) {
      console.error(`Token verification failed for ${platformType}:`, verifyError.message);
      // Continue with email from request if verification fails
    }

    // Check if user already exists
    const existingUser = await User.findOne({ 
      $or: [
        { email: verifiedEmail },
        ...(googleId ? [{ googleId }] : [])
      ]
    });

    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Create user in both collections (Users + role-specific)
    const newUser = await createUserWithRole({
      name,
      email: verifiedEmail,
      password: null, // No password for Google auth
      role,
      googleId,
      photoUrl,
      authProvider: 'google'
    });

    // Generate JWT
    const token = jwt.sign(
      { userId: newUser._id, role: newUser.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: "User Registered Successfully with Google",
      token,
      userId: newUser._id,
      name: newUser.name,
      role: newUser.role,
    });
  } catch (error) {
    console.error('Google registration error:', error);
    res.status(500).json({ error: 'Google registration failed' });
  }
});

// ==================== DRIVER ROUTES ====================

// UPLOAD PROFILE PHOTO
app.post('/driver/upload-profile', authMiddleware, upload.single('photo'), async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Only drivers can upload profile photos" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    driver.profilePhoto = req.file.filename;
    driver.isApproved = true; // Auto-approve after photo upload
    await driver.save();

    res.json({ 
      message: "Profile photo uploaded successfully",
      profilePhoto: driver.profilePhoto,
      isApproved: true
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
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
      canActivate: driver.isApproved && driver.profilePhoto
    });
  } catch (err) {
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

    res.json({ isActive: driver.isActive });
  } catch (err) {
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
      { 
        'assignments.driverId': driver._id,
        'assignments.status': { $in: ['assigned', 'in_transit'] }
      },
      { 
        $set: { 
          'assignments.$.currentLocation': {
            latitude,
            longitude,
            updatedAt: new Date()
          }
        }
      }
    );

    res.json({ message: "Location updated" });
  } catch (err) {
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

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const allOrders = await Order.find({ 
      'assignments.driverId': driver._id 
    }).sort({ createdAt: -1 });
    
    const todayRides = allOrders.filter(order => {
      const pickupDate = new Date(order.pickupDateTime);
      pickupDate.setHours(0, 0, 0, 0);
      return pickupDate.getTime() === today.getTime();
    });

    const currentAssignment = allOrders.find(order => {
      const assignment = order.assignments.find(a => 
        a.driverId.toString() === driver._id.toString()
      );
      return assignment && (assignment.status === 'assigned' || assignment.status === 'in_transit');
    });

    res.json({
      todayRides: todayRides.length,
      totalRides: driver.stats.totalRides,
      completedRides: driver.stats.completedRides,
      currentAssignment: currentAssignment || null,
      recentOrders: allOrders.slice(0, 5),
      profileStatus: {
        hasProfilePhoto: !!driver.profilePhoto,
        isApproved: driver.isApproved,
        isActive: driver.isActive
      }
    });
  } catch (err) {
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
    res.status(500).json({ error: "Server error" });
  }
});

// UPLOAD VEHICLE IMAGES (Driver) - Minimum 10 images required
app.post('/orders/:orderId/upload-images', authMiddleware, upload.array('images', 50), async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Only drivers can upload images" });
    }

    if (req.files.length < 10) {
      return res.status(400).json({ error: "Minimum 10 images required" });
    }

    const { orderId } = req.params;
    const order = await Order.findById(orderId);
    
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    const assignment = order.assignments.find(a => 
      a.driverId.toString() === driver._id.toString()
    );
    
    if (!assignment) {
      return res.status(403).json({ error: "You are not assigned to this order" });
    }

    assignment.vehicleImages = req.files.map(file => file.filename);
    assignment.status = 'in_transit';
    assignment.startedAt = new Date();
    
    // Update order status if all assignments are in transit
    const allInTransit = order.assignments.every(a => 
      a.status === 'in_transit' || a.status === 'completed'
    );
    if (allInTransit) {
      order.status = 'in_transit';
    }
    
    await order.save();

    res.json({ 
      message: "Images uploaded successfully",
      imageCount: req.files.length 
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// COMPLETE RIDE (Driver)
app.post('/orders/:orderId/complete', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Only drivers can complete rides" });
    }

    const { orderId } = req.params;
    const order = await Order.findById(orderId);
    
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const driver = await Driver.findOne({ userId: req.userId });
    const assignment = order.assignments.find(a => 
      a.driverId.toString() === driver._id.toString()
    );
    
    if (!assignment) {
      return res.status(403).json({ error: "You are not assigned to this order" });
    }

    if (assignment.status !== 'in_transit') {
      return res.status(400).json({ error: "Order must be in transit to complete" });
    }

    assignment.status = 'completed';
    assignment.completedAt = new Date();
    
    // Check if all assignments are completed
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
    res.status(500).json({ error: "Server error" });
  }
});

app.put('/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    await Notification.findByIdAndUpdate(req.params.id, { isRead: true });
    res.json({ message: "Notification marked as read" });
  } catch (err) {
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
});