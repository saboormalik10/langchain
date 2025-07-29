const mysql = require('mysql2/promise');
require('dotenv').config();

async function checkDatabase() {
  try {
    // Create a connection
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: process.env.DB_PORT
    });
    
    console.log('✅ Connected to MySQL database');
    
    // Check all tables
    console.log('🔍 Checking database tables...');
    const [tables] = await connection.query('SHOW TABLES');
    console.log('📊 Tables in database:');
    tables.forEach(table => {
      console.log(`   - ${Object.values(table)[0]}`);
    });
    
    // Count patients
    console.log('\n📋 Counting patients...');
    const [patientCount] = await connection.query('SELECT COUNT(*) as count FROM patients');
    console.log(`   Total patients: ${patientCount[0].count}`);
    
    // Get all patients
    console.log('\n👥 Fetching ALL patients:');
    const [patients] = await connection.query('SELECT * FROM patients');
    console.log(JSON.stringify(patients, null, 2));
    
    // Count medications
    console.log('\n💊 Counting medications...');
    const [medCount] = await connection.query('SELECT COUNT(*) as count FROM medications');
    console.log(`   Total medications: ${medCount[0].count}`);
    
    // Get medications with dosage <= 250mg
    console.log('\n💊 Fetching medications with dosage <= 250mg:');
    const [lowDosageMeds] = await connection.query(`
      SELECT * FROM medications 
      WHERE dosage LIKE '%1mg%' OR dosage LIKE '%5mg%' OR dosage LIKE '%10mg%' OR 
            dosage LIKE '%25mg%' OR dosage LIKE '%50mg%' OR dosage LIKE '%100mg%' OR 
            dosage LIKE '%150mg%' OR dosage LIKE '%200mg%' OR dosage LIKE '%250mg%'
    `);
    console.log(JSON.stringify(lowDosageMeds, null, 2));
    
    // Get patient-medication matches for low dosage
    console.log('\n🔍 Fetching patients with medications having dosage <= 250mg:');
    const [patientMeds] = await connection.query(`
      SELECT p.*, m.* 
      FROM patients p
      JOIN medications m ON p.id = m.patient_id
      WHERE m.dosage LIKE '%1mg%' OR m.dosage LIKE '%5mg%' OR m.dosage LIKE '%10mg%' OR 
            m.dosage LIKE '%25mg%' OR m.dosage LIKE '%50mg%' OR m.dosage LIKE '%100mg%' OR 
            m.dosage LIKE '%150mg%' OR m.dosage LIKE '%200mg%' OR m.dosage LIKE '%250mg%'
    `);
    console.log(JSON.stringify(patientMeds, null, 2));
    
    await connection.end();
    console.log('\n✅ Database check completed');
  
  } catch (error) {
    console.error('❌ Database error:', error.message);
  }
}

checkDatabase();
