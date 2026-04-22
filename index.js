const express = require('express');
const app = express();
const cron = require('node-cron');

function formatTiempo(horasDecimal) {
  const totalMin = Math.floor(horasDecimal * 60);
  const horas = Math.floor(totalMin / 60);
  const minutos = totalMin % 60;

  if (horas > 0) {
    return `${horas}h ${minutos}m`;
  } else {
    return `${minutos}m`;
  }
}
app.get('/', (req, res) => {
  res.send('Bot activo');
});

app.listen(3000, () => {
  console.log('Web funcionando');
});

const { 
  Client, 
  GatewayIntentBits, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  EmbedBuilder, 
  ModalBuilder, 
  TextInputBuilder, 
  TextInputStyle
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// 🔧 CONFIG
const STATS_CHANNEL_ID = '1495703920733978694';
const AUTO_CHANNEL_ID = '1495703822339936306';
const REPORT_CHANNEL_ID = '1495703722343530537';
const STAFF_ROLE_IDS = ['1495644560666398831'];
const EMPLOYEE_CHANNEL_ID = '1496621548461625535'

const AFK_TIME = 7 * 60 * 60 * 1000;

// 🧠 DATA
const data = {};
const totalHoras = {};
const timers = {};
const confirmTimers = {};
const intervals = {};

let panelID = null;
let panelChannel = null;
let statsMessageID = null;

let inactivityPanelID = null;
let inactivityChannel = null;

// ================= PANEL PONCHE =================
async function refreshPanel() {
  if (!panelChannel) return;

  try {
    if (panelID) {
      const old = await panelChannel.messages.fetch(panelID);
      await old.delete();
    }
  } catch {}

  const embed = new EmbedBuilder()
    .setTitle('🍩 Sistema de Ponches')
    .setDescription('Usa los botones para registrar tu jornada')
    .setColor('#ff4bd1')
    .setImage('https://cdn.discordapp.com/attachments/1495631128139268206/1496470001928896623/IMG_4028.gif');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('entrada').setLabel('🟢 Entrada').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('salida').setLabel('🔴 Salida').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('horas').setLabel('⏱ Horas').setStyle(ButtonStyle.Primary)
  );

  const msg = await panelChannel.send({ embeds: [embed], components: [row] });
  panelID = msg.id;
}

// ================= PANEL INACTIVIDAD =================
async function refreshInactivityPanel() {
  if (!inactivityChannel) return;

  const embed = new EmbedBuilder()
    .setTitle('📋 Sistema de Inactividad')
    .setDescription('Presiona el botón para reportar tu ausencia')
    .setColor('#ffaa00')
    .setImage('https://i.imgur.com/yNtX66r.jpg');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('reportar').setLabel('📩 Reportar Inactividad').setStyle(ButtonStyle.Primary)
  );

  const msg = await inactivityChannel.send({ embeds: [embed], components: [row] });
  inactivityPanelID = msg.id;
}

// 🔥 MANTENER PANEL ABAJO
async function mantenerPanelAbajo() {
  if (!inactivityChannel || !inactivityPanelID) return;

  try {
    const msg = await inactivityChannel.messages.fetch(inactivityPanelID);
    await msg.delete();
  } catch {}

  inactivityPanelID = null;
  refreshInactivityPanel();
}

// ================= LEADERBOARD =================
async function updateLeaderboard(guild) {
  const channel = guild.channels.cache.get(STATS_CHANNEL_ID);
  if (!channel) return;

  const ranking = Object.entries(totalHoras).sort((a,b)=>b[1]-a[1]).slice(0,10);

  let texto = '';
  ranking.forEach((u,i)=>{
    const m = guild.members.cache.get(u[0]);
    const medal = ['🥇','🥈','🥉'][i] || '🔹';
    texto += `${medal} ${m?.displayName || 'Usuario'} | ${formatTiempo(u[1])}\n`;
  });

  const embed = new EmbedBuilder()
    .setTitle('🏆 Ranking de Empleados')
    .setDescription(texto + `\n👥 Total empleados: ${Object.keys(totalHoras).length}`)
    .setColor('#ffd700')
    .setImage('https://i.imgur.com/FTWRO4r.png');

  try {
    if (statsMessageID) {
      const old = await channel.messages.fetch(statsMessageID);
      await old.delete();
    }
  } catch {}

  const msg = await channel.send({ embeds:[embed] });
  statsMessageID = msg.id;
}
////////////////////////////EMPLEADOS////////////////////////////////////////////////
async function updateEmployeeList(guild) {
  const channel = guild.channels.cache.get(EMPLOYEE_CHANNEL_ID);
  if (!channel) return;

  const members = await guild.members.fetch();

  let enServicio = 0;
  let fueraServicio = 0;
  let lista = '';

  let i = 1;
  for(const member of members.values()) {
    if (member.user.bot) continue;

    const trabajando = data[member.user.id];

    if (trabajando) {
      enServicio++;
      lista += `${i}. 🟢 ${member}\n`;
    } else {
      fueraServicio++;
      lista += `${i}. 🔴 ${member}\n`;
    }

    i++;
  }

  const embed = new EmbedBuilder()
    .setTitle('📋 Lista de Empleados - Donuts Empleados')
    .setDescription(
`**Total:** ${enServicio + fueraServicio} empleados
🟢 En Servicio: ${enServicio}
🔴 Fuera de Servicio: ${fueraServicio}
👥 **Empleados**
${lista}`
    )
    .setColor('#ffd700')
    .setImage('https://cdn.discordapp.com/attachments/1495631128139268206/1496470001928896623/IMG_4028.gif') // tu gif
    .setFooter({ text: '🔄 Actualizado automáticamente' });

  try {
    const messages = await channel.messages.fetch({ limit: 10 });
    const botMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length);

    if (botMsg) {
      await botMsg.edit({ embeds: [embed] });
    } else {
      await channel.send({ embeds: [embed] });
    }
  } catch {
    await channel.send({ embeds: [embed] });
  }
}

// ================= AFK =================
function startAFK(interaction,user){
  if (timers[user]) clearTimeout(timers[user]);

  timers[user] = setTimeout(async ()=>{
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('seguir').setLabel('Sigo activo').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('afk_no').setLabel('No').setStyle(ButtonStyle.Danger)
  );

  let tiempoRestante = 180; // 3 minutos en segundos

  let msg;

  try {
    const dm = await interaction.user.createDM();

    msg = await dm.send({
      content: `⚠️ ¿Sigues trabajando?\n⏳ Tiempo restante: 03:00`,
      components: [row]
    });

  } catch {
    msg = await interaction.channel.send({
      content: `⚠️ ${interaction.member} ¿Sigues trabajando?\n⏳ Tiempo restante: 03:00`,
      components: [row]
    });
  }

  // 🔥 CONTADOR
  const interval = setInterval(async () => {
    tiempoRestante--;

    const min = Math.floor(tiempoRestante / 60);
    const sec = tiempoRestante % 60;

    const tiempoTexto = `${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;

    if (tiempoRestante <= 0) {
      clearInterval(interval);
      return;
    }

    try {
      await msg.edit({
        content: `⚠️ ¿Sigues trabajando?\n⏳ Tiempo restante: ${tiempoTexto}`,
        components: [row]
      });
    } catch {}
  }, 1000);

  confirmTimers[user] = setTimeout(()=>{
    clearInterval(interval);
    autoSalida(interaction,user);
  },180000);

},AFK_TIME);
}

async function autoSalida(interaction,user){
  if (!data[user]) return;

  const ch = interaction.guild.channels.cache.get(AUTO_CHANNEL_ID);

  const embed = new EmbedBuilder()
    .setTitle('🚫 Turno Finalizado Automáticamente')
    .setDescription(
      `👤 ${interaction.member}\n\n` +
      `⚠️ No respondiste.\n📉 Inactividad detectada.\n❌ Tiempo no registrado.`
    )
    .setColor('#ff0000')
    .setImage('https://i.imgur.com/JTmf52O.png');

  delete data[user];

  if (ch) ch.send({ embeds:[embed] });
}

// ================= INTERACCIONES =================
client.on('interactionCreate', async (interaction)=>{

  const user = interaction.user.id;

  // SEGUIR
  if (interaction.isButton() && interaction.customId === 'seguir') {
    if (confirmTimers[user]) clearTimeout(confirmTimers[user]);
    if (timers[user]) clearTimeout(timers[user]);

    data[user] = Date.now();
    startAFK(interaction, user);

    return interaction.reply({ content: '✅ Sigues activo', ephemeral: true });
  }

  // AFK NO
  if (interaction.isButton() && interaction.customId === 'afk_no') {

    //Detener contador aqui 
    if (intervals[user]) {
      clearInterval(intervals[user]);
      delete intervals[user];
    }

    if (!data[user]) return interaction.reply({ content: '❌ Ya no estás en servicio', ephemeral: true });

    const tiempoMs = Date.now() - data[user];

    const minutos = Math.floor(tiempoMs / 60000);
    const horas = Math.floor(minutos / 60);
    const minsRestantes = minutos % 60;

    let tiempoFinal = horas > 0 ? `${horas}h ${minsRestantes}m` : `${minsRestantes}m`;

    totalHoras[user] = (totalHoras[user] || 0) + (tiempoMs / 3600000);
    delete data[user];

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🔴 Salida automática AFK')
          .setDescription(`${interaction.member}\n⏱️ ${tiempoFinal}`)
          .setColor('Red')
      ]
    });
  }

  // APROBAR
  if (interaction.isButton() && interaction.customId.startsWith('aprobar_')) {
    await interaction.deferReply({ ephemeral:true });

    if (!STAFF_ROLE_IDS.some(id => interaction.member.roles.cache.has(id))) {
      return interaction.editReply({ content:'❌ No tienes permiso' });
    }

    await interaction.message.edit({ components: [] });
    await interaction.editReply({ content:'✅ Reporte aprobado' });

    return mantenerPanelAbajo();
  }

  // RECHAZAR
  if (interaction.isButton() && interaction.customId.startsWith('rechazar_')) {
    await interaction.deferReply({ ephemeral:true });

    if (!STAFF_ROLE_IDS.some(id => interaction.member.roles.cache.has(id))) {
      return interaction.editReply({ content:'❌ No tienes permiso' });
    }

    await interaction.message.edit({ components: [] });
    await interaction.editReply({ content:'❌ Reporte rechazado' });

    return mantenerPanelAbajo();
  }

  // ENTRADA
  if (interaction.isButton() && interaction.customId === 'entrada') {

  data[user] = Date.now();
  startAFK(interaction, user);

  //actualiza lista //
  updateEmployeeList(interaction.guild);

  const embed = new EmbedBuilder()
    .setTitle('🟢 En Servicio')
    .setDescription(`${interaction.member.displayName}\n⏱️ Tiempo: 0m`)
    .setColor('Green')
    .setImage('https://i.imgur.com/iy4wcni.png');

  const msg = await interaction.channel.send({ embeds: [embed] });

  // 🔥 CONTADOR EN VIVO
  intervals[user] = setInterval(async () => {
    const tiempoMs = Date.now() - data[user];

    const minutos = Math.floor(tiempoMs / 60000);
    const horas = Math.floor(minutos / 60);
    const minsRestantes = minutos % 60;

    let tiempoTexto = horas > 0 
      ? `${horas}h ${minsRestantes}m` 
      : `${minsRestantes}m`;

    embed.setDescription(`${interaction.member.displayName}\n⏱️ Tiempo: ${tiempoTexto}`);

    try {
      await msg.edit({ embeds: [embed] });
    } catch {}
  }, 60000); // cada 1 minuto

  await interaction.deferUpdate();
  return refreshPanel();
}

  // SALIDA
  if (interaction.isButton() && interaction.customId === 'salida'){

    //Detener contador
    if (intervals[user]) {
      clearInterval(intervals[user]);
      delete intervals[user];
    }

    if (!data[user]) return interaction.reply({ content:'❌ No has hecho entrada', ephemeral:true });

    const tiempoMs = Date.now() - data[user];

const minutos = Math.floor(tiempoMs / 60000);
const horas = Math.floor(minutos / 60);
const minsRestantes = minutos % 60;

let tiempoFinal = horas > 0 
  ? `${horas}h ${minsRestantes}m` 
  : `${minsRestantes}m`;

totalHoras[user] = (totalHoras[user] || 0) + (tiempoMs / 3600000);
delete data[user];

//actualiza lista //
  updateEmployeeList(interaction.guild);

await interaction.channel.send({
  embeds: [
    new EmbedBuilder()
      .setTitle('🔴 Se fue de servicio ese vago')
      .setDescription(
  `👤 ${interaction.member.displayName}

📊 Tiempo trabajado:
⏱️ ${tiempoFinal}`
)
      .setColor('Red')
      .setImage('https://i.imgur.com/14hUy4X.png')
  ]
});

    await interaction.deferUpdate();
    updateLeaderboard(interaction.guild);
    return refreshPanel();
  }

  // REPORTAR
  if (interaction.isButton() && interaction.customId === 'reportar') {

    const modal = new ModalBuilder()
      .setCustomId('modal_reporte')
      .setTitle('Reportar Inactividad');

    const razon = new TextInputBuilder()
      .setCustomId('razon')
      .setLabel('Razón')
      .setStyle(TextInputStyle.Paragraph);

    const tiempo = new TextInputBuilder()
      .setCustomId('tiempo')
      .setLabel('Duración')
      .setStyle(TextInputStyle.Short);

    modal.addComponents(
      new ActionRowBuilder().addComponents(razon),
      new ActionRowBuilder().addComponents(tiempo)
    );

    return interaction.showModal(modal);
  }

  // MODAL
  if (interaction.isModalSubmit() && interaction.customId === 'modal_reporte') {

    const razon = interaction.fields.getTextInputValue('razon');
    const tiempo = interaction.fields.getTextInputValue('tiempo');

    const ch = interaction.guild.channels.cache.get(REPORT_CHANNEL_ID);

    const embed = new EmbedBuilder()
      .setTitle('📨 Nuevo Reporte')
      .setDescription(`👤 ${interaction.member}\n⏱ ${tiempo}\n📝 ${razon}`)
      .setColor('#ffaa00');

    const botones = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`aprobar_${user}`).setLabel('Aprobar').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`rechazar_${user}`).setLabel('Rechazar').setStyle(ButtonStyle.Danger)
    );

    if (ch) ch.send({ embeds:[embed], components:[botones] });

    await interaction.reply({ content:'✅ Reporte enviado', ephemeral:true });

    return mantenerPanelAbajo();
  }

});

// ================= COMANDOS =================
client.on('messageCreate', async (msg)=>{
  if (msg.content === '!panel'){
    panelChannel = msg.channel;
    refreshPanel();
  }

  if (msg.content === '!empleados') {
  updateEmployeeList(msg.guild);
}

  if (msg.content === '!inactividad'){
    inactivityChannel = msg.channel;
    refreshInactivityPanel();
  }
});

// 🔥 CUANDO EL BOT PRENDE
client.once('ready', () => {
  console.log('🟢 Bot listo');

  // 👥 Lista de empleados (canal separado)
  setInterval(() => {
    for (let guild of client.guilds.cache.values()) {
      updateEmployeeList(guild);
    }
  }, 60000);

  // 🏆 Reset ranking semanal
  cron.schedule('0 0 * * 1', async () => {
    console.log('♻️ Reiniciando ranking semanal');

    for (let user in totalHoras) {
      totalHoras[user] = 0;
    }

    for (let guild of client.guilds.cache.values()) {
      updateLeaderboard(guild);
    }
  });
});

client.login(process.env.TOKEN);