🚚 Drivetics – Vehicle Transport Logistics Platform

A full-stack logistics platform designed to streamline vehicle transportation operations by connecting Customers, Drivers, and Administrators through a secure role-based system. The platform enables customers to schedule vehicle transport requests, administrators to manage operations and assign drivers, and drivers to execute deliveries while maintaining inspection records and ride status updates.

✨ Features
👤 Customer Module
Secure registration and login
Create vehicle transport requests
Specify pickup/drop locations, vehicle count, and schedule
Track order status throughout the transportation lifecycle
🚗 Driver Module
Secure authentication
View assigned transportation tasks
Toggle availability status (Active / Inactive)
Upload vehicle inspection images before transport
Access current and historical assignments
Receive assignment notifications
🧑‍💼 Admin Module
Dashboard with operational analytics
Monitor active drivers and customers
View and manage transportation orders
Automatically assign available drivers to orders
Receive email alerts for new ride bookings
Track order progress and transportation status
🔔 Notification System
In-app notifications
Assignment notifications for drivers
New booking alerts for administrators
Order status updates
📸 Vehicle Inspection System
Upload vehicle inspection images before transport
Maintain digital records for safety and accountability
🏗️ System Architecture
Flutter Apps (Customer / Driver / Admin)
                    │
                    ▼
           Node.js + Express
                    │
                    ▼
          MongoDB Atlas Database
                    │
                    ▼
     Email Notifications (Nodemailer)
🛠️ Tech Stack
Frontend
Flutter
HTML/CSS (Landing Website)
Backend
Node.js
Express.js
Database
MongoDB Atlas
Mongoose ODM
Authentication & Security
JWT (JSON Web Tokens)
bcrypt.js
File Uploads
Multer
Notifications
Nodemailer
Deployment & Infrastructure
AWS EC2
Nginx Reverse Proxy
Testing & Development
Postman
Git & GitHub
🔐 Security Features
Password hashing using bcrypt
JWT-based authentication
Role-based access control
Protected API routes
Secure MongoDB Atlas connectivity
Environment variable management
📊 Order Lifecycle
Pending
   ↓
Assigned
   ↓
In Transit
   ↓
Completed
📂 Core Collections
Users

Stores:

Admins
Customers
Drivers
Orders

Stores:

Pickup & drop information
Vehicle count
Order status
Customer details
Notifications

Stores:

User notifications
Assignment alerts
Status updates
Leads (Website Intents)

Stores:

Website inquiries
Customer intent submissions
🚀 Deployment

Backend deployed on AWS EC2 and served through Nginx as a reverse proxy.

Services Used
AWS EC2
Nginx
MongoDB Atlas
Gmail SMTP (Nodemailer)
📈 Key Highlights
Role-Based Access Control (RBAC)
RESTful API Architecture
Driver Assignment Automation
Vehicle Inspection Workflow
Email Notification System
Scalable MongoDB Data Modeling
Cloud Deployment on AWS
Real-world Logistics Management Use Case
👨‍💻 Author

Krishna Bajpai

Built as a production-oriented logistics platform to simplify vehicle transportation operations through secure backend architecture, scalable database design, and cloud deployment.
