const { neon } = require('@neondatabase/serverless');

const dbUrl = process.env.DATABASE_URL || process.env.STORAGE_DATABASE_URL;
const sql = dbUrl ? neon(dbUrl) : null;

const studentsDefault = [
  ["Elise Arrieta","Line Leader"],["Guhan Aroul","Door Holder"],["Casper Kamali","Light Helper"],
  ["Ruby Rodriguez","Calendar Helper"],["James Selkirk","Weather Monitor"],["Lucy Hammer","Snack Helpers"],
  ["Nicholas Luna","Snack Helpers"],["Eliana Ayala","Sweeper"],["James Leibfarth","Pencil Patrol"],
  ["Zedek Lobo","Librarian"],["Eli Hamilton","Paper Passer"],["Jenna Jonson","Caboose"],
  ["Owen Alspach","Purple Folder Monitor"],["Eleanor Pelletier","Teacher Helper"]
];
const jobs=["Line Leader","Door Holder","Light Helper","Calendar Helper","Weather Monitor","Snack Helpers","Sweeper","Pencil Patrol","Librarian","Paper Passer","Caboose","Purple Folder Monitor","Teacher Helper","Stand-In Star"];

function calendarMonth(d=new Date()){ return d.toISOString().slice(0,7); }
function nextMonth(mk){ const [y,m]=mk.split("-").map(Number); const d=new Date(Date.UTC(y,m,1)); return d.toISOString().slice(0,7); }
function teacherOK(req){ return !!process.env.TEACHER_PIN && req.headers["x-teacher-pin"] === process.env.TEACHER_PIN; }
async function init(){
  await sql`CREATE TABLE IF NOT EXISTS students(id SERIAL PRIMARY KEY,name TEXT UNIQUE NOT NULL,current_job TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS jobs(id SERIAL PRIMARY KEY,name TEXT UNIQUE NOT NULL)`;
  await sql`CREATE TABLE IF NOT EXISTS ballots(month_key TEXT NOT NULL,student_name TEXT NOT NULL,first_choice TEXT,second_choice TEXT,third_choice TEXT,submitted_at TIMESTAMPTZ DEFAULT now(),PRIMARY KEY(month_key,student_name))`;
  await sql`CREATE TABLE IF NOT EXISTS assignments(month_key TEXT NOT NULL,student_name TEXT NOT NULL,job_name TEXT NOT NULL,finalized_at TIMESTAMPTZ DEFAULT now(),PRIMARY KEY(month_key,student_name))`;
  await sql`CREATE TABLE IF NOT EXISTS job_history(id SERIAL PRIMARY KEY,student_name TEXT NOT NULL,job_name TEXT NOT NULL,month_key TEXT NOT NULL)`;
  await sql`CREATE TABLE IF NOT EXISTS app_settings(setting_key TEXT PRIMARY KEY,setting_value TEXT NOT NULL)`;
  for(const [name,job] of studentsDefault) await sql`INSERT INTO students(name,current_job) VALUES(${name},${job}) ON CONFLICT(name) DO NOTHING`;
  for(const job of jobs) await sql`INSERT INTO jobs(name) VALUES(${job}) ON CONFLICT(name) DO NOTHING`;
  for(const [name,job] of studentsDefault) await sql`INSERT INTO job_history(student_name,job_name,month_key) SELECT ${name},${job},'initial' WHERE NOT EXISTS (SELECT 1 FROM job_history WHERE student_name=${name} AND job_name=${job} AND month_key='initial')`;
  const mk=calendarMonth();
  await sql`INSERT INTO app_settings(setting_key,setting_value) VALUES('current_month',${mk}) ON CONFLICT(setting_key) DO NOTHING`;
}
async function currentMonth(){ const r=await sql`SELECT setting_value FROM app_settings WHERE setting_key='current_month'`; return r[0]?.setting_value || calendarMonth(); }

module.exports = async (req,res)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type,x-teacher-pin");
  if(req.method==="OPTIONS") return res.status(204).end();
  if(!sql) return res.status(500).json({error:"Database is not connected yet."});
  try{
    await init();
    const action=req.query.action||"studentRoster";
    const mk=await currentMonth();
    const body=req.body||{};

    if(action==="verifyTeacher"){
      if(!process.env.TEACHER_PIN) return res.status(503).json({error:"Teacher PIN is not configured in Vercel yet."});
      return res.status(teacherOK(req)?200:401).json({ok:teacherOK(req)});
    }

    if(action==="studentRoster"){
      const [s,j]=await Promise.all([
        sql`SELECT name,current_job FROM students ORDER BY id`,
        sql`SELECT name FROM jobs ORDER BY id`
      ]);
      return res.json({monthKey:mk,students:s,jobs:j.map(x=>x.name)});
    }

    if(!teacherOK(req)) return res.status(401).json({error:"Teacher PIN required."});

    if(action==="bootstrap"){
      const [s,j,b,a,h]=await Promise.all([
        sql`SELECT name,current_job FROM students ORDER BY id`,
        sql`SELECT name FROM jobs ORDER BY id`,
        sql`SELECT * FROM ballots WHERE month_key=${mk} ORDER BY student_name`,
        sql`SELECT * FROM assignments WHERE month_key=${mk} ORDER BY student_name`,
        sql`SELECT student_name,job_name,month_key FROM job_history ORDER BY student_name,month_key`
      ]);
      return res.json({monthKey:mk,students:s,jobs:j.map(x=>x.name),ballots:b,assignments:a,history:h});
    }

    if(action==="ballot"){
      const {studentName,first,second,third}=body;
      const st=(await sql`SELECT current_job FROM students WHERE name=${studentName}`)[0];
      if(!st) return res.status(400).json({error:"Student not found."});
      if(![first,second,third].every(x=>jobs.includes(x)) || new Set([first,second,third]).size!==3) return res.status(400).json({error:"Please provide three different choices."});
      if([first,second,third].includes(st.current_job)) return res.status(400).json({error:"Your current job cannot be selected."});
      await sql`INSERT INTO ballots(month_key,student_name,first_choice,second_choice,third_choice) VALUES(${mk},${studentName},${first},${second},${third}) ON CONFLICT(month_key,student_name) DO UPDATE SET first_choice=EXCLUDED.first_choice,second_choice=EXCLUDED.second_choice,third_choice=EXCLUDED.third_choice,submitted_at=now()`;
      return res.json({ok:true});
    }

    if(action==="clearBallot"){
      if(!body.studentName) return res.status(400).json({error:"Student name required."});
      await sql`DELETE FROM ballots WHERE month_key=${mk} AND student_name=${body.studentName}`;
      return res.json({ok:true});
    }

    if(action==="addStudent"){
      const name=String(body.name||"").trim(), currentJob=body.currentJob||null;
      if(!name) return res.status(400).json({error:"Name required."});
      if(currentJob && !jobs.includes(currentJob)) return res.status(400).json({error:"Invalid current job."});
      await sql`INSERT INTO students(name,current_job) VALUES(${name},${currentJob}) ON CONFLICT(name) DO UPDATE SET current_job=EXCLUDED.current_job`;
      if(currentJob) await sql`INSERT INTO job_history(student_name,job_name,month_key) SELECT ${name},${currentJob},'initial' WHERE NOT EXISTS (SELECT 1 FROM job_history WHERE student_name=${name} AND job_name=${currentJob} AND month_key='initial')`;
      return res.json({ok:true});
    }

    if(action==="finalize"){
      const assignments=Array.isArray(body.assignments)?body.assignments:[];
      const students=await sql`SELECT name,current_job FROM students ORDER BY id`;
      if(assignments.length!==students.length) return res.status(400).json({error:"Every student must have exactly one assignment."});
      const names=new Set(students.map(x=>x.name)), seenStudents=new Set(), counts={};
      for(const x of assignments){
        if(!names.has(x.studentName) || seenStudents.has(x.studentName) || !jobs.includes(x.jobName)) return res.status(400).json({error:"Assignments contain an invalid or duplicate student/job."});
        const st=students.find(s=>s.name===x.studentName);
        if(x.jobName===st.current_job) return res.status(400).json({error:x.studentName+" cannot repeat the current job."});
        seenStudents.add(x.studentName); counts[x.jobName]=(counts[x.jobName]||0)+1;
      }
      const missing=jobs.filter(j=>!counts[j]);
      if(missing.length) return res.status(400).json({error:"Every job must be filled. Missing: "+missing.join(", ")});
      if((counts["Snack Helpers"]||0)<1) return res.status(400).json({error:"Snack Helpers must be assigned."});
      for(const x of assignments){
        await sql`INSERT INTO assignments(month_key,student_name,job_name) VALUES(${mk},${x.studentName},${x.jobName}) ON CONFLICT(month_key,student_name) DO UPDATE SET job_name=EXCLUDED.job_name,finalized_at=now()`;
        await sql`INSERT INTO job_history(student_name,job_name,month_key) SELECT ${x.studentName},${x.jobName},${mk} WHERE NOT EXISTS (SELECT 1 FROM job_history WHERE student_name=${x.studentName} AND job_name=${x.jobName} AND month_key=${mk})`;
        await sql`UPDATE students SET current_job=${x.jobName} WHERE name=${x.studentName}`;
      }
      return res.json({ok:true,monthKey:mk});
    }

    if(action==="startMonth"){
      const newMonth=body.monthKey || nextMonth(mk);
      if(!/^\\d{4}-\\d{2}$/.test(newMonth)) return res.status(400).json({error:"Month must be YYYY-MM."});
      await sql`UPDATE app_settings SET setting_value=${newMonth} WHERE setting_key='current_month'`;
      return res.json({ok:true,monthKey:newMonth});
    }

    return res.status(404).json({error:"Unknown action"});
  }catch(e){ console.error(e); return res.status(500).json({error:e.message}); }
};