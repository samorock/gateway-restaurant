'use strict';
/* Loads SAMPLE restaurants and menus so you can try the app. Run once: npm run seed
   Then replace them with your real restaurants on the /admin page. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, hashPw, slug, PALETTE } = require('./server');

const SAMPLE = [
 ['Mama Egba Buka','Kuto',['Nigerian Food'],'25-35',4.8,[['Amala, Gbegiri & Ewedu',2500,'Amala & Swallow','Soft amala with gbegiri, ewedu and stew'],['Amala with Ewedu & Assorted',3500,'Amala & Swallow','Assorted meat, ponmo and shaki'],['Pounded Yam & Egusi',4000,'Amala & Swallow','Rich egusi with goat meat'],['Pounded Yam & Efo Riro',4000,'Amala & Swallow','Spinach stew with fish and meat'],['Eba & Okro Soup',3000,'Amala & Swallow','Okro with ponmo and fish'],['Extra Meat',800,'Add-ons','One piece of beef or goat meat'],['Zobo (50cl)',700,'Drinks','Chilled hibiscus drink']]],
 ['Ofada Hut','Oke-Ilewo',['Nigerian Food','Rice'],'30-40',4.6,[['Ofada Rice & Ayamase',3500,'Rice','Local rice with green pepper sauce and assorted meat'],['Ofada Rice & Designer Stew',3800,'Rice','With eggs, ponmo and beef'],['Native Jollof Rice',2800,'Rice','Smoky firewood-style jollof with plantain'],['Fried Plantain (dodo)',800,'Add-ons','Ripe plantain, fried golden'],['Moi Moi',1000,'Add-ons','Steamed bean pudding with fish'],['Chapman (50cl)',1500,'Drinks','Classic Nigerian Chapman']]],
 ['Lafenwa Grill & Suya','Lafenwa',['Grills & Suya'],'30-45',4.7,[['Beef Suya (regular)',3000,'Grills','Spicy yaji, onions and tomato'],['Chicken Suya (half)',4500,'Grills','Grilled over charcoal'],['Ram Suya (large)',5500,'Grills','Tender ram with extra yaji'],['Asun (peppered goat)',4500,'Grills','Smoky, spicy goat chunks'],['Grilled Catfish',8000,'Grills','Whole catfish with pepper sauce'],['Kilishi (pack)',2000,'Snacks','Dried spiced beef strips'],['Bottled Water',300,'Drinks','75cl']]],
 ['Panseke Chops','Panseke',['Fast Food'],'20-30',4.4,[['Chicken Shawarma',3500,'Fast Food','Grilled chicken, cabbage, sausage and sauce'],['Beef Burger',3800,'Fast Food','Beef patty, cheese, lettuce and tomato'],['Chicken & Chips',4500,'Fast Food','Fried chicken with seasoned fries'],['Meat Pie',1200,'Snacks','Baked pie with minced beef'],['Puff Puff (10)',1000,'Snacks','Soft and sugary'],['Fruit Smoothie',2500,'Drinks','Pineapple and banana'],['Soft Drink',600,'Drinks','Coke, Fanta or Sprite']]],
 ['Ibara Rice Bowl','Ibara',['Rice','Fast Food'],'30-40',4.5,[['Party Jollof & Chicken',3500,'Rice','Jollof rice, fried chicken and coleslaw'],['Fried Rice & Turkey',5000,'Rice','Fried rice with peppered turkey and plantain'],['Jollof Rice (plain)',2000,'Rice','Just the rice, hot'],['White Rice & Stew',2500,'Rice','With beef and fried plantain'],['Spaghetti & Meatballs',3200,'Rice','Peppery spaghetti with two meatballs'],['Extra Chicken',2000,'Add-ons','One fried chicken piece'],['Malt Drink',800,'Drinks','Chilled malt']]],
 ['FUNAAB Bites','FUNAAB',['Fast Food','Nigerian Food'],'25-35',4.3,[['Indomie Special',2500,'Noodles','Noodles with egg, sausage and veg'],['Yam & Egg Sauce',2500,'Nigerian Meals','Fried yam with egg sauce'],['Akara & Pap',1500,'Snacks','Bean cakes with hot pap'],['Bread & Egg Sandwich',1500,'Snacks','Toasted bread with fried egg'],['Chin Chin (bag)',1000,'Snacks','Crunchy and sweet'],['Zobo (50cl)',700,'Drinks','Chilled hibiscus drink'],['Bottled Water',300,'Drinks','75cl']]],
];

if (db.prepare('SELECT COUNT(*) n FROM restaurants').get().n > 0) { console.log('Restaurants already exist. Nothing was added.'); process.exit(0); }
const out = [];
SAMPLE.forEach(([name, area, tags, time, rating, items], i) => {
  const id = slug(name), salt = crypto.randomBytes(16).toString('hex'), pw = crypto.randomBytes(5).toString('hex'), [c1, c2] = PALETTE[i % PALETTE.length];
  db.prepare('INSERT INTO restaurants(id,name,area,tags,time,rating,c1,c2,open,bank_name,acct_name,acct_no,salt,pass_hash,created) VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)')
    .run(id, name, area, JSON.stringify(tags), time, rating, c1, c2, 'Sample Bank', name + ' (sample)', '0123456789', salt, hashPw(pw, salt), Date.now() + i);
  for (const [n, p, c, d] of items) db.prepare('INSERT INTO menu_items(rid,name,price,cat,descr,avail) VALUES(?,?,?,?,?,1)').run(id, n, p, c, d);
  out.push(`${name}  |  restaurant id: ${id}  |  password: ${pw}`);
});
const file = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'sample-logins.txt');
fs.writeFileSync(file, out.join('\n') + '\n');
console.log('Sample restaurants added. Vendor logins:\n' + out.join('\n') + '\n(Saved to ' + file + ')');
