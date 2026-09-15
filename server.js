const express=require("express");
const path=require("path");
const bcrypt=require("bcryptjs");
const jwt=require("jsonwebtoken");
const multer=require("multer");
const {Pool}=require("pg");

const app=express();
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,"public")));

const upload=multer({dest:path.join(__dirname,"uploads")});
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL?{rejectUnauthorized:false}:false});
const JWT_SECRET=process.env.JWT_SECRET||"change-this-in-render";

async function init(){
  await pool.query(`
  CREATE TABLE IF NOT EXISTS users(
    id SERIAL PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer',name TEXT DEFAULT '',
    wallet NUMERIC(12,2) NOT NULL DEFAULT 0,created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS products(
    id SERIAL PRIMARY KEY,name TEXT NOT NULL,image_url TEXT DEFAULT '',description TEXT DEFAULT '',
    active BOOLEAN DEFAULT true,created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS plans(
    id SERIAL PRIMARY KEY,product_id INT REFERENCES products(id) ON DELETE CASCADE,
    name TEXT NOT NULL,customer_price NUMERIC(12,2) NOT NULL DEFAULT 0,
    reseller_price NUMERIC(12,2) NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS special_prices(
    id SERIAL PRIMARY KEY,plan_id INT REFERENCES plans(id) ON DELETE CASCADE,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    price NUMERIC(12,2) NOT NULL, UNIQUE(plan_id,user_id)
  );
  CREATE TABLE IF NOT EXISTS keys_inventory(
    id SERIAL PRIMARY KEY,product_id INT REFERENCES products(id) ON DELETE CASCADE,
    secret_key TEXT NOT NULL, status TEXT DEFAULT 'available',
    assigned_to INT REFERENCES users(id),assigned_at TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS deposits(
    id SERIAL PRIMARY KEY,user_id INT REFERENCES users(id),amount NUMERIC(12,2) NOT NULL,
    utr TEXT DEFAULT '',screenshot TEXT DEFAULT '',status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT now(),reviewed_at TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS purchases(
    id SERIAL PRIMARY KEY,user_id INT REFERENCES users(id),plan_id INT REFERENCES plans(id),
    key_id INT REFERENCES keys_inventory(id),amount NUMERIC(12,2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  );`);
  const admin=await pool.query("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if(!admin.rowCount){
    const hash=await bcrypt.hash("Admin@12345",10);
    await pool.query("INSERT INTO users(email,password_hash,role,name) VALUES($1,$2,'admin','Administrator')",
      ["admin@example.com",hash]);
  }
}
init().catch(console.error);

function auth(req,res,next){
  try{req.user=jwt.verify((req.headers.authorization||"").replace("Bearer ",""),JWT_SECRET);next();}
  catch(e){res.status(401).json({error:"Login required"});}
}
function admin(req,res,next){if(req.user.role!=="admin")return res.status(403).json({error:"Admin only"});next();}

app.post("/api/register",async(req,res)=>{
  try{
    const {name,email,password}=req.body;
    if(!email||!password||password.length<6)return res.status(400).json({error:"Email and password (6+ chars) required"});
    const hash=await bcrypt.hash(password,10);
    const r=await pool.query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,email,role,name,wallet",
      [name||"",email.toLowerCase(),hash]);
    res.json({user:r.rows[0]});
  }catch(e){res.status(400).json({error:"Email already registered"});}
});
app.post("/api/login",async(req,res)=>{
  const r=await pool.query("SELECT * FROM users WHERE email=$1",[String(req.body.email||"").toLowerCase()]);
  if(!r.rowCount||!(await bcrypt.compare(req.body.password||"",r.rows[0].password_hash)))return res.status(401).json({error:"Invalid login"});
  const u=r.rows[0], token=jwt.sign({id:u.id,email:u.email,role:u.role,name:u.name},JWT_SECRET,{expiresIn:"7d"});
  res.json({token,user:{id:u.id,email:u.email,role:u.role,name:u.name,wallet:u.wallet}});
});
app.get("/api/me",auth,async(req,res)=>{
  const r=await pool.query("SELECT id,email,role,name,wallet FROM users WHERE id=$1",[req.user.id]);res.json(r.rows[0]);
});
app.get("/api/products",auth,async(req,res)=>{
  const r=await pool.query(`SELECT p.*,json_agg(json_build_object('id',pl.id,'name',pl.name,'customer_price',pl.customer_price,'reseller_price',pl.reseller_price) ORDER BY pl.id) FILTER(WHERE pl.id IS NOT NULL) plans
  FROM products p LEFT JOIN plans pl ON pl.product_id=p.id WHERE p.active=true GROUP BY p.id ORDER BY p.id DESC`);
  res.json(r.rows);
});
app.get("/api/keys",auth,async(req,res)=>{
  const r=await pool.query(`SELECT k.id,p.name product,k.secret_key,k.status,k.assigned_at
    FROM keys_inventory k JOIN products p ON p.id=k.product_id WHERE k.assigned_to=$1 ORDER BY k.assigned_at DESC`,[req.user.id]);
  res.json(r.rows);
});

app.post("/api/deposits",auth,upload.single("screenshot"),async(req,res)=>{
  const amount=Number(req.body.amount);
  if(!(amount>0))return res.status(400).json({error:"Invalid amount"});
  const shot=req.file?req.file.filename:"";
  const r=await pool.query("INSERT INTO deposits(user_id,amount,utr,screenshot) VALUES($1,$2,$3,$4) RETURNING *",
    [req.user.id,amount,req.body.utr||"",shot]);
  res.json(r.rows[0]);
});

app.post("/api/purchase",auth,async(req,res)=>{
  const plan=await pool.query("SELECT * FROM plans WHERE id=$1",[req.body.plan_id]);
  if(!plan.rowCount)return res.status(404).json({error:"Plan not found"});
  const pl=plan.rows[0];
  let price=req.user.role==="reseller"?Number(pl.reseller_price):Number(pl.customer_price);
  const sp=await pool.query("SELECT price FROM special_prices WHERE plan_id=$1 AND user_id=$2",[pl.id,req.user.id]);
  if(sp.rowCount)price=Number(sp.rows[0].price);
  const key=await pool.query("SELECT * FROM keys_inventory WHERE product_id=$1 AND status='available' ORDER BY id LIMIT 1",[pl.product_id]);
  if(!key.rowCount)return res.status(409).json({error:"No key available"});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const u=await client.query("SELECT wallet FROM users WHERE id=$1 FOR UPDATE",[req.user.id]);
    if(Number(u.rows[0].wallet)<price)throw new Error("Insufficient wallet balance");
    await client.query("UPDATE users SET wallet=wallet-$1 WHERE id=$2",[price,req.user.id]);
    await client.query("UPDATE keys_inventory SET status='sold',assigned_to=$1,assigned_at=now() WHERE id=$2",[req.user.id,key.rows[0].id]);
    await client.query("INSERT INTO purchases(user_id,plan_id,key_id,amount) VALUES($1,$2,$3,$4)",[req.user.id,pl.id,key.rows[0].id,price]);
    await client.query("COMMIT");
    res.json({success:true,key:key.rows[0].secret_key,price});
  }catch(e){await client.query("ROLLBACK");res.status(400).json({error:e.message});}finally{client.release();}
});

/* Admin */
app.get("/api/admin/deposits",auth,admin,async(req,res)=>{
  const r=await pool.query(`SELECT d.*,u.email,u.name FROM deposits d JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC`);res.json(r.rows);
});
app.post("/api/admin/deposits/:id/:action",auth,admin,async(req,res)=>{
  if(!["approve","reject"].includes(req.params.action))return res.status(400).json({error:"Invalid action"});
  const d=await pool.query("SELECT * FROM deposits WHERE id=$1 FOR UPDATE",[req.params.id]);
  if(!d.rowCount||d.rows[0].status!=="pending")return res.status(400).json({error:"Already reviewed"});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const row=d.rows[0], status=req.params.action==="approve"?"approved":"rejected";
    if(status==="approved")await client.query("UPDATE users SET wallet=wallet+$1 WHERE id=$2",[row.amount,row.user_id]);
    await client.query("UPDATE deposits SET status=$1,reviewed_at=now() WHERE id=$2",[status,row.id]);
    await client.query("COMMIT");res.json({success:true});
  }catch(e){await client.query("ROLLBACK");res.status(500).json({error:"Could not update"});}finally{client.release();}
});
app.post("/api/admin/products",auth,admin,async(req,res)=>{
  const {name,image_url,description,plans=[]}=req.body;
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const p=(await client.query("INSERT INTO products(name,image_url,description) VALUES($1,$2,$3) RETURNING *",[name,image_url||"",description||""])).rows[0];
    for(const x of plans)await client.query("INSERT INTO plans(product_id,name,customer_price,reseller_price) VALUES($1,$2,$3,$4)",[p.id,x.name,Number(x.customer_price),Number(x.reseller_price)]);
    await client.query("COMMIT");res.json(p);
  }catch(e){await client.query("ROLLBACK");res.status(400).json({error:e.message});}finally{client.release();}
});
app.post("/api/admin/keys",auth,admin,async(req,res)=>{
  const productId=Number(req.body.product_id), keys=String(req.body.keys||"").split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(!productId||!keys.length)return res.status(400).json({error:"Product and keys required"});
  for(const k of keys)await pool.query("INSERT INTO keys_inventory(product_id,secret_key) VALUES($1,$2)",[productId,k]);
  res.json({added:keys.length});
});
app.get("/api/admin/products",auth,admin,async(req,res)=>{
  const r=await pool.query(`SELECT p.*,COUNT(k.id) FILTER(WHERE k.status='available') available_keys
  FROM products p LEFT JOIN keys_inventory k ON k.product_id=p.id GROUP BY p.id ORDER BY p.id DESC`);res.json(r.rows);
});
app.post("/api/admin/special-price",auth,admin,async(req,res)=>{
  const u=await pool.query("SELECT id FROM users WHERE email=$1",[String(req.body.email||"").toLowerCase()]);
  if(!u.rowCount)return res.status(404).json({error:"User not found"});
  await pool.query(`INSERT INTO special_prices(plan_id,user_id,price) VALUES($1,$2,$3)
  ON CONFLICT(plan_id,user_id) DO UPDATE SET price=EXCLUDED.price`,[req.body.plan_id,u.rows[0].id,Number(req.body.price)]);
  res.json({success:true});
});
app.post("/api/admin/user-role",auth,admin,async(req,res)=>{
  if(!["customer","reseller"].includes(req.body.role))return res.status(400).json({error:"Invalid role"});
  await pool.query("UPDATE users SET role=$1 WHERE email=$2",[req.body.role,String(req.body.email||"").toLowerCase()]);
  res.json({success:true});
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
const PORT=process.env.PORT||10000;
app.listen(PORT,()=>console.log("Server on "+PORT));
