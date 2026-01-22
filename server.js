require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
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
const atlasUri =process.env.MONGO_URI;


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

// USER MODEL
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'customer', 'driver'], required: true },
  isActive: { type: Boolean, default: true }, // For driver status
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", UserSchema);

// ORDER MODEL
const OrderSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  customerName: { type: String, required: true },
  customerEmail: { type: String, required: true },
  pickupLocation: { type: String, required: true },
  dropLocation: { type: String, required: true },
  pickupDateTime: { type: Date, required: true },
  vehicleCount: { type: Number, required: true },
  status: { 
    type: String, 
    enum: ['pending', 'assigned', 'in_transit', 'completed', 'cancelled'],
    default: 'pending'
  },
  assignments: [{
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    driverName: { type: String },
    status: { type: String, enum: ['assigned', 'in_transit', 'completed'], default: 'assigned' },
    vehicleImages: [{ type: String }],
    assignedAt: { type: Date, default: Date.now },
    completedAt: { type: Date }
  }],
  createdAt: { type: Date, default: Date.now }
});

const Order = mongoose.model("Order", OrderSchema);

// NOTIFICATION MODEL
const NotificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  type: { type: String, enum: ['order', 'assignment', 'status'], required: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
  isRead: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

// CUSTOMER INTENT MODEL
const CustomerIntentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String, required: true },
  message: { type: String },
  createdAt: { type: Date, default: Date.now }
});

const CustomerIntent = mongoose.model("customer_intent", CustomerIntentSchema);


const Notification = mongoose.model("Notification", NotificationSchema);

// JWT MIDDLEWARE
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

// REGISTER
app.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (!['admin', 'customer', 'driver'].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: "Email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ name, email, password: hashedPassword, role });
    await newUser.save();

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

// LOGIN
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

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
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// CREATE ORDER (Customer)
app.post('/orders', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'customer') {
      return res.status(403).json({ error: "Only customers can create orders" });
    }

    const { pickupLocation, dropLocation, pickupDateTime, vehicleCount } = req.body;

    const user = await User.findById(req.userId);
    
    const order = new Order({
      customerId: req.userId,
      customerName: user.name,
      customerEmail: user.email,
      pickupLocation,
      dropLocation,
      pickupDateTime,
      vehicleCount
    });

    await order.save();

    await sendAdminEmail(
  "🚚 New Ride Booked | Drivetics",
  `
New ride has been booked.

Customer Name: ${user.name}
Customer Email: ${user.email}

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
        message: `${user.name} requested transport for ${vehicleCount} vehicles`,
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

// GET ORDERS (with filters)
app.get('/orders', authMiddleware, async (req, res) => {
  try {
    let query = {};
    
    if (req.userRole === 'customer') {
      query.customerId = req.userId;
    } else if (req.userRole === 'driver') {
      query['assignments.driverId'] = req.userId;
    }

    const { status } = req.query;
    if (status) {
      query.status = status;
    }

    const orders = await Order.find(query).sort({ createdAt: -1 });
    res.json(orders);
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

    // Get active drivers
    const activeDrivers = await User.find({ role: 'driver', isActive: true }).limit(order.vehicleCount);
    
    if (activeDrivers.length < order.vehicleCount) {
      return res.status(400).json({ error: "Not enough active drivers available" });
    }

    // Assign drivers
    order.assignments = activeDrivers.map(driver => ({
      driverId: driver._id,
      driverName: driver.name,
      status: 'assigned'
    }));
    order.status = 'assigned';
    await order.save();

    // Create notifications for drivers
    for (let driver of activeDrivers) {
      await new Notification({
        userId: driver._id,
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

// UPLOAD VEHICLE IMAGES (Driver)
app.post('/orders/:orderId/upload-images', authMiddleware, upload.array('images', 10), async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Only drivers can upload images" });
    }

    const { orderId } = req.params;
    const order = await Order.findById(orderId);
    
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const assignment = order.assignments.find(a => a.driverId.toString() === req.userId);
    if (!assignment) {
      return res.status(403).json({ error: "You are not assigned to this order" });
    }

    assignment.vehicleImages = req.files.map(file => file.filename);
    assignment.status = 'in_transit';
    
    // Update order status if all assignments are in transit
    const allInTransit = order.assignments.every(a => a.status === 'in_transit' || a.status === 'completed');
    if (allInTransit) {
      order.status = 'in_transit';
    }
    
    await order.save();

    res.json({ message: "Images uploaded successfully" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// GET DRIVER DASHBOARD DATA
app.get('/driver/dashboard', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const allOrders = await Order.find({ 'assignments.driverId': req.userId });
    
    const todayRides = allOrders.filter(order => {
      const pickupDate = new Date(order.pickupDateTime);
      pickupDate.setHours(0, 0, 0, 0);
      return pickupDate.getTime() === today.getTime();
    });

    const currentAssignment = allOrders.find(order => {
      const assignment = order.assignments.find(a => a.driverId.toString() === req.userId);
      return assignment && (assignment.status === 'assigned' || assignment.status === 'in_transit');
    });

    res.json({
      todayRides: todayRides.length,
      totalRides: allOrders.length,
      currentAssignment: currentAssignment || null,
      recentOrders: allOrders.slice(0, 5)
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// GET ADMIN DASHBOARD DATA
app.get('/admin/dashboard', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: "Access denied" });
    }

    const totalDrivers = await User.countDocuments({ role: 'driver' });
    const activeDrivers = await User.countDocuments({ role: 'driver', isActive: true });
    const totalCustomers = await User.countDocuments({ role: 'customer' });
    
    const pendingOrders = await Order.countDocuments({ status: 'pending' });
    const inTransitOrders = await Order.countDocuments({ status: 'in_transit' });
    const completedOrders = await Order.countDocuments({ status: 'completed' });

    const recentOrders = await Order.find().sort({ createdAt: -1 }).limit(10);
    const drivers = await User.find({ role: 'driver' });

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

// TOGGLE DRIVER STATUS
app.put('/driver/toggle-status', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'driver') {
      return res.status(403).json({ error: "Access denied" });
    }

    const driver = await User.findById(req.userId);
    driver.isActive = !driver.isActive;
    await driver.save();

    res.json({ isActive: driver.isActive });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// GET NOTIFICATIONS
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

// MARK NOTIFICATION AS READ
app.put('/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    await Notification.findByIdAndUpdate(req.params.id, { isRead: true });
    res.json({ message: "Notification marked as read" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});


// CUSTOMER INTENT FROM WEBSITE (PUBLIC)
app.post("/customer-intent", async (req, res) => {
  try {
    const { name, phone, email, message } = req.body;

    if (!name || !phone || !email) {
      return res.status(400).send("Missing required fields");
    }

    // 1️⃣ Save intent in MongoDB
    const intent = new CustomerIntent({
      name,
      phone,
      email,
      message
    });
    await intent.save();

    // 2️⃣ Send email to admin
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

    // 3️⃣ Create notification for ALL admins
    const admins = await User.find({ role: "admin" });
    for (let admin of admins) {
      await new Notification({
        userId: admin._id,
        title: "New Customer Intent",
        message: `${name} submitted a pickup request`,
        type: "order"
      }).save();
    }

    // 4️⃣ Response to website user
    res.json({ success: true });



  } catch (err) {
    console.error("CUSTOMER INTENT ERROR:", err.message);
    res.status(500).send("Something went wrong. Please try again later.");
  }
});



const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});