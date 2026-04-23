const { 
  Client, GatewayIntentBits, EmbedBuilder, 
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');

const fs = require('fs');
const cron = require('node-cron');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const CONFIG = {
  PANEL_CHANNEL: '1495735101135392888',
  EMPLOYEE_CHANNEL: '1496621548461625535',
  RANK_CHANNEL: '1495703920733978694',
  REPORT_CHANNEL: '1495703722343530537',
  AUTO_CHANNEL: '1495703822339936306',
  STAFF_ROLE: '1495644560666398831'
};

let db = fs.existsSync('data.json') ? JSON.parse(fs.readFileSync('data.json')) : {};
function save(){ fs.writeFileSync('data.json', JSON.stringify(db,null,2)); }

// ================= TIEMPO =================
function format(ms){
  const m = Math.floor(ms/60000);
  const h = Math.floor(m/60);
  return h>0 ? `${h}h ${m%60}m` : `${m}m`;
}

// ================= PANEL =================
let panelID;

async function updatePanel(guild){
  const ch = guild.channels.cache.get(CONFIG.PANEL_CHANNEL);
  if(!ch) return;

  try{
    if(panelID){
      const old = await ch.messages.fetch(panelID);
      await old.delete();
    }
  }catch{}

  const embed = new EmbedBuilder()
    .setTitle('🍩 Sistema de Ponche')
    .setDescription('🟢 Entrada\n🔴 Salida\n\n⏱️ Tu tiempo se actualiza automáticamente')
    .setImage('https://cdn.discordapp.com/attachments/1495631128139268206/1496470001928896623/IMG_4028.gif')
    .setColor('#ff4bd1');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('in').setLabel('Entrada').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('out').setLabel('Salida').setStyle(ButtonStyle.Danger)
  );

  const msg = await ch.send({embeds:[embed],components:[row]});
  panelID = msg.id;
}

// ================= EMPLEADOS =================
let empID;

async function updateEmployees(guild){
  const ch = guild.channels.cache.get(CONFIG.EMPLOYEE_CHANNEL);
  if(!ch) return;

  const members = await guild.members.fetch();

  let en=0, off=0, txt='';

  members.forEach(m=>{
    if(m.user.bot) return;

    const active = db[m.id]?.active;

    if(active){
      en++;
      txt+=`🟢 ${m.displayName}\n`;
    }else{
      off++;
      txt+=`🔴 ${m.displayName}\n`;
    }
  });

  const embed = new EmbedBuilder()
    .setTitle('📋 Lista de Empleados')
    .setDescription(`👥 Total: ${en+off}\n🟢 ${en} | 🔴 ${off}\n\n${txt}`)
    .setImage('https://cdn.discordapp.com/attachments/1495631128139268206/1496470001928896623/IMG_4028.gif')
    .setColor('#ffd700')
    .setFooter({text:'Actualizado en vivo'});

  try{
    if(empID){
      const old = await ch.messages.fetch(empID);
      return old.edit({embeds:[embed]});
    }
  }catch{}

  const msg = await ch.send({embeds:[embed]});
  empID = msg.id;
}

// ================= RANK =================
let rankID;

async function updateRank(guild){
  const ch = guild.channels.cache.get(CONFIG.RANK_CHANNEL);
  if(!ch) return;

  const sorted = Object.entries(db)
    .map(([id,v])=>[id,v.total||0])
    .sort((a,b)=>b[1]-a[1]);

  let txt='';

  sorted.slice(0,10).forEach((u,i)=>{
    const medal=['🥇','🥈','🥉'][i]||'🔹';
    const m = guild.members.cache.get(u[0]);
    txt+=`${medal} ${m?.displayName} | ${format(u[1])}\n`;
  });

  const embed = new EmbedBuilder()
    .setTitle('🏆 Ranking Semanal')
    .setDescription(txt)
    .setColor('#ffd700');

  try{
    if(rankID){
      const old = await ch.messages.fetch(rankID);
      return old.edit({embeds:[embed]});
    }
  }catch{}

  const msg = await ch.send({embeds:[embed]});
  rankID = msg.id;
}

// ================= AFK =================
function startAFK(user,interaction){
  setTimeout(async()=>{
    if(!db[user]?.active) return;

    let t=180;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('stay').setLabel('Sigo activo').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('leave').setLabel('Salir').setStyle(ButtonStyle.Danger)
    );

    const dm = await interaction.user.send(`⚠️ ¿Sigues trabajando?\n⏳ ${t}s`);
    
    const int = setInterval(()=>{
      t--;
      if(t<=0){
        clearInterval(int);
        delete db[user].active;
        save();

        interaction.guild.channels.cache.get(CONFIG.AUTO_CHANNEL)
        .send(`🚫 Auto salida: ${interaction.member}`);
      }
      dm.edit(`⚠️ ¿Sigues trabajando?\n⏳ ${t}s`);
    },1000);

  },5*60*60*1000);
}

// ================= INTERACCIONES =================
client.on('interactionCreate', async i=>{
  if(!i.isButton()) return;

  const id=i.user.id;
  if(!db[id]) db[id]={total:0};

  if(i.customId==='in'){
    db[id].active=Date.now();
    save();
    startAFK(id,i);
    updateEmployees(i.guild);
    return i.reply({content:'🟢 Entrada registrada',ephemeral:true});
  }

  if(i.customId==='out'){
    if(!db[id].active) return;

    const t=Date.now()-db[id].active;
    db[id].total+=t;
    delete db[id].active;

    save();
    updateEmployees(i.guild);
    updateRank(i.guild);

    return i.reply({content:`🔴 Salida (${format(t)})`,ephemeral:true});
  }

  if(i.customId==='stay'){
    db[id].active=Date.now();
    save();
    return i.reply({content:'✅ Sigues activo',ephemeral:true});
  }

  if(i.customId==='leave'){
    delete db[id].active;
    save();
    return i.reply({content:'🚫 Saliste',ephemeral:true});
  }
});

// ================= REPORTES =================
client.on('interactionCreate', async i=>{
  if(i.customId==='report'){
    const modal = new ModalBuilder()
      .setCustomId('rep')
      .setTitle('Reporte de Inactividad');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('txt')
          .setLabel('Motivo')
          .setStyle(TextInputStyle.Paragraph)
      )
    );

    return i.showModal(modal);
  }

  if(i.isModalSubmit()){
    const txt = i.fields.getTextInputValue('txt');

    const ch = i.guild.channels.cache.get(CONFIG.REPORT_CHANNEL);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ok_${i.user.id}`).setLabel('Aprobar').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`no_${i.user.id}`).setLabel('Rechazar').setStyle(ButtonStyle.Danger)
    );

    ch.send({
      embeds:[
        new EmbedBuilder()
        .setTitle('📋 Nuevo Reporte')
        .setDescription(`${i.user}\n\n${txt}`)
        .setColor('#ffaa00')
      ],
      components:[row]
    });

    i.reply({content:'Reporte enviado',ephemeral:true});
  }

  if(i.customId?.startsWith('ok_') || i.customId?.startsWith('no_')){
    if(!i.member.roles.cache.has(CONFIG.STAFF_ROLE)) return;

    i.update({
      embeds:[
        new EmbedBuilder()
        .setTitle(i.customId.startsWith('ok_') ? '✅ APROBADO' : '❌ RECHAZADO')
        .setDescription(`Procesado por ${i.user}`)
      ],
      components:[]
    });
  }
});

// ================= RESET =================
cron.schedule('0 0 * * 1', ()=>{
  for(let u in db) db[u].total=0;
  save();
});

// ================= READY =================
client.once('ready',()=>{
  console.log('🔥 BOT PRO LISTO');

  client.guilds.cache.forEach(g=>{
    updatePanel(g);
    updateEmployees(g);
    updateRank(g);
  });
});

client.login(process.env.TOKEN);