'use strict';
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { connectDb, mongoose, User } = require('../src/db');

async function seedUsersOnly() {
  console.log('=== Seeding MongoDB: Users & Mentors Cohort ===');
  await connectDb();
  console.log('✓ Connected to MongoDB');

  const pwHash = bcrypt.hashSync('pass123', 10);

  // 1. Provision Admins
  const admins = [
    { name: 'Utkarsha Kasar', email: 'utkarsha.kasar@kalvium.com', can_t: 1, can_hr: 1 },
    { name: 'Prachi Sharma', email: 'prachi.sharma@kalvium.com', can_t: 0, can_hr: 0 },
    { name: 'Ashish Suresh', email: 'ashish.suresh@kalvium.com', can_t: 0, can_hr: 0 },
    { name: 'Akshata Sanap', email: 'akshata.sanap@kalvium.com', can_t: 0, can_hr: 1 }, // Admin & Non-Tech Mentor
  ];

  for (const a of admins) {
    let exists = await User.findOne({ email: a.email });
    if (!exists) {
      await User.create({
        name: a.name,
        email: a.email,
        password_hash: pwHash,
        role: 'admin',
        can_technical: a.can_t,
        can_hr: a.can_hr,
        active: 1,
      });
      console.log('✓ Provisioned Admin:', a.email);
    } else {
      await User.updateOne({ email: a.email }, { $set: { role: 'admin', can_technical: a.can_t, can_hr: a.can_hr, active: 1 } });
    }
  }

  // 2. Provision Mentors
  const mentors = [
    { name: 'Manav Verma', email: 'manav.verma@kalvium.com', can_t: 1, can_hr: 0 },
    { name: 'Muskan Srivastava', email: 'muskan.srivastava@kalvium.com', can_t: 0, can_hr: 1 },
    { name: 'Ritu Soni', email: 'ritu.soni@kalvium.com', can_t: 1, can_hr: 0 },
    { name: 'Shikhar Agarwal', email: 'shikhar.agarwal@kalvium.com', can_t: 1, can_hr: 0 },
    { name: 'Shivam Shrivastava', email: 'shivam.shrivastava@kalvium.com', can_t: 1, can_hr: 0 },
    { name: 'Aditya Kulshreshtha', email: 'aditya.kulshreshtha@kalvium.com', can_t: 1, can_hr: 0 },
    { name: 'Hrituparno C', email: 'hrituparno.c@kalvium.com', can_t: 1, can_hr: 0 },
    { name: 'Navaneeth V', email: 'navaneeth.v@kalvium.com', can_t: 0, can_hr: 1 },
    { name: 'Kanishka Ragavi', email: 'kanishka.ragavi@kalvium.com', can_t: 0, can_hr: 1 },
  ];

  for (const m of mentors) {
    let exists = await User.findOne({ email: m.email });
    if (!exists) {
      await User.create({
        name: m.name,
        email: m.email,
        password_hash: pwHash,
        role: 'mentor',
        can_technical: m.can_t,
        can_hr: m.can_hr,
        active: 1,
      });
      console.log('✓ Provisioned Mentor:', m.email);
    } else {
      await User.updateOne({ email: m.email }, { $set: { can_technical: m.can_t, can_hr: m.can_hr, active: 1 } });
    }
  }

  // 3. Provision Default Students (40 Candidates)
  const students = [
    // Squad 116 (18 candidates)
    { name: 'Isha Agrawal', email: 'isha.agrawal.s.116@kalvium.community', squad: '116', roll_no: 'KAL116001' },
    { name: 'Aditya Talikoti', email: 'aditya.talikoti.s.116@kalvium.community', squad: '116', roll_no: 'KAL116002' },
    { name: 'Digvijay Patil', email: 'digvijay.patil.s.116@kalvium.community', squad: '116', roll_no: 'KAL116003' },
    { name: 'Anisha Santosh Agrawal', email: 'anisha.agrawal.s.116@kalvium.community', squad: '116', roll_no: 'KAL116004' },
    { name: 'Areesh Ahmed', email: 'areesh.ahmed.s.116@kalvium.community', squad: '116', roll_no: 'KAL116005' },
    { name: 'Kanishka Nishchal Girnar', email: 'kanishka.girnar.s.116@kalvium.community', squad: '116', roll_no: 'KAL116006' },
    { name: 'Aditya Sudhir Nagane', email: 'aditya.nagane.s.116@kalvium.community', squad: '116', roll_no: 'KAL116007' },
    { name: 'Shubham Uddhav Reddy', email: 'shubham.reddy.s.116@kalvium.community', squad: '116', roll_no: 'KAL116008' },
    { name: 'Yashwardhan Santosh Chaudhari', email: 'yashwardhan.chaudhari.s.116@kalvium.community', squad: '116', roll_no: 'KAL116009' },
    { name: 'Yashraj Jagtap', email: 'yashraj.jagtap.s.116@kalvium.community', squad: '116', roll_no: 'KAL116010' },
    { name: 'Aryan Patil', email: 'aryan.patil.s.116@kalvium.community', squad: '116', roll_no: 'KAL116011' },
    { name: 'Om Lonkar', email: 'om.lonkar.s.116@kalvium.community', squad: '116', roll_no: 'KAL116012' },
    { name: 'Gauri Mhetre', email: 'gauri.mhetre.s.116@kalvium.community', squad: '116', roll_no: 'KAL116013' },
    { name: 'Avadhut Murlidhar Pawar', email: 'avadhut.pawar.s.116@kalvium.community', squad: '116', roll_no: 'KAL116014' },
    { name: 'Riddhima Sinhal', email: 'riddhima.sinhal.s.116@kalvium.community', squad: '116', roll_no: 'KAL116015' },
    { name: 'Hardik Kaurani', email: 'hardik.kaurani.s.116@kalvium.community', squad: '116', roll_no: 'KAL116016' },
    { name: 'Tejas Vijaykumar Pujari', email: 'tejas.pujari.s.116@kalvium.com', squad: '116', roll_no: 'KAL116017' },
    { name: 'Khushal Rajput', email: 'khushal.rajput.s.116@kalvium.community', squad: '116', roll_no: 'KAL116018' },

    // Squad 115 (22 candidates)
    { name: 'Aayushman Shukla', email: 'aayushman.shukla.s.115@kalvium.community', squad: '115', roll_no: 'KAL115001' },
    { name: 'Prithvi Rajvanshi', email: 'prithvi.rajvanshi.s.115@kalvium.community', squad: '115', roll_no: 'KAL115002' },
    { name: 'Palakshi Verma', email: 'palakshi.verma.s.115@kalvium.community', squad: '115', roll_no: 'KAL115003' },
    { name: 'Ruhaa Bhalerao', email: 'ruhaa.bhalerao.s.115@kalvium.community', squad: '115', roll_no: 'KAL115004' },
    { name: 'Pratite Acharya', email: 'pratite.a.s.115@kalvium.community', squad: '115', roll_no: 'KAL115005' },
    { name: 'Ayush Shriam Awchar', email: 'shriram.awchar.s.115@kalvium.community', squad: '115', roll_no: 'KAL115006' },
    { name: 'varad shahane', email: 'varad.shahane.s.115@kalvium.community', squad: '115', roll_no: 'KAL115007' },
    { name: 'Raina George', email: 'raina.george.s.115@kalvium.community', squad: '115', roll_no: 'KAL115008' },
    { name: 'Shauryvardhan Dadasaheb Undre', email: 'shauryvardhan.undre.s.115@kalvium.community', squad: '115', roll_no: 'KAL115009' },
    { name: 'Om Jagtap', email: 'om.jagtap.s.115@kalvium.community', squad: '115', roll_no: 'KAL115010' },
    { name: 'Aadi Jain', email: 'aadi.jain.s.115@kalvium.community', squad: '115', roll_no: 'KAL115011' },
    { name: 'Parnil Vyawhare', email: 'parnil.vyawahare.s.115@kalvium.community', squad: '115', roll_no: 'KAL115012' },
    { name: 'Atharv Nitin Hargude', email: 'atharv.hargude.s.115@kalvium.community', squad: '115', roll_no: 'KAL115013' },
    { name: 'Sasmit Narnaware', email: 'sasmit.narnaware.s.115@kalvium.community', squad: '115', roll_no: 'KAL115014' },
    { name: 'Rakshaad Ashok Kolhe', email: 'rakshaad.kolhe.s.115@kalvium.community', squad: '115', roll_no: 'KAL115015' },
    { name: 'Sohini Tandon', email: 'sohini.tandon.s.115@kalvium.community', squad: '115', roll_no: 'KAL115016' },
    { name: 'Rishikesh Bagal', email: 'rishikesh.bagal.s.115@kalvium.community', squad: '115', roll_no: 'KAL115017' },
    { name: 'vinayak kulkarni', email: 'vinayak.kulkarni.s.115@kalvium.community', squad: '115', roll_no: 'KAL115018' },
    { name: 'Gitesh Makunda Chaudhari', email: 'gitesh.c.s.115@kalvium.community', squad: '115', roll_no: 'KAL115019' },
    { name: 'Devansh Subhash Pujari', email: 'devansh.pujari.s.115@kalvium.community', squad: '115', roll_no: 'KAL115020' },
    { name: 'Mohammad Aamir Patloo', email: 'mohammad.patloo.s.115@kalvium.community', squad: '115', roll_no: 'KAL115021' },
    { name: 'Shruti Shardul Itkalkar', email: 'shruti.itkalkar.s.115@kalvium.community', squad: '115', roll_no: 'KAL115022' }
  ];

  for (const s of students) {
    let exists = await User.findOne({ email: s.email });
    if (!exists) {
      await User.create({
        name: s.name,
        email: s.email,
        password_hash: pwHash,
        role: 'student',
        squad: s.squad,
        roll_no: s.roll_no,
        branch: 'CSE',
        phone: '+91 98765 43210',
        resume_url: 'https://drive.google.com/resume.pdf',
        active: 1,
      });
      console.log('✓ Provisioned Student:', s.email);
    } else {
      await User.updateOne({ email: s.email }, { $set: { role: 'student', squad: s.squad, roll_no: s.roll_no, active: 1 } });
    }
  }

  const userCount = await User.countDocuments();
  console.log(`✓ Total Users in MongoDB: ${userCount}`);
  console.log('=== Seeding Complete ===');
  await mongoose.disconnect();
}

seedUsersOnly().catch(err => {
  console.error('Seeding failed:', err.message);
  process.exit(1);
});
