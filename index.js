const express = require('express');
const fs = require('fs');
const app = express();

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder
} = require('discord.js');

function formatTiempo(horasDecimal) {
  const totalMin = Math.floor(horasDecimal * 60);
  const horas = Math.floor(totalMin / 60);
  const minutos = totalMin % 60;

  if (horas > 0) return `${horas}h ${minutos}m`;
  return `${minutos}m`;
}

function cortarTexto(texto, max = 1000) {
  if (!texto) return 'No especificado';
  if (texto.length <= max) return texto;
  return texto.slice(0, max - 3) + '...';
}

function fechaDiscord(ms = Date.now()) {
  return `<t:${Math.floor(ms / 1000)}:F>`;
}

app.get('/', (req, res) => {
  res.send('Bot activo');
});

app.listen(3000, () => {
  console.log('Web funcionando');
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const STATS_CHANNEL_ID = '1495703920733978694';
const AUTO_CHANNEL_ID = '1495703822339936306';
const REPORT_CHANNEL_ID = '1495703722343530537';
const STAFF_ROLE_IDS = ['1495644560666398831'];

const AFK_TIME = 4 * 60 * 60 * 1000;
const DB_FILE = './database.json';

const data = {};
const timers = {};
const confirmTimers = {};
const intervals = {};
const afkMessages = {};
const afkIntervals = {};
const userGuilds = {};
const inactivityReports = {};

let db = {
  empleados: {},
  horas: {},
  rankingMessageId: null,
  lastMondayUpdate: null
};

function guardarDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function cargarDB() {
  if (!fs.existsSync(DB_FILE)) {
    guardarDB();
    return;
  }

  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.empleados = db.empleados || {};
    db.horas = db.horas || {};
    db.rankingMessageId = db.rankingMessageId || null;
    db.lastMondayUpdate = db.lastMondayUpdate || null;
  } catch {
    guardarDB();
  }
}

function esStaff(member) {
  return STAFF_ROLE_IDS.some(id => member.roles.cache.has(id));
}

function estaContratado(userId) {
  return !!db.empleados[userId];
}

cargarDB();

let panelID = null;
let panelChannel = null;

let inactivityPanelID = null;
let inactivityChannel = null;

let refreshingPanel = false;
let refreshingInactivityPanel = false;
let refreshPanelTimeout = null;
let refreshPanelQueued = false;

// ================= PANEL PONCHE =================
async function refreshPanel() {
  if (!panelChannel) return;

  if (refreshingPanel) {
    refreshPanelQueued = true;
    return;
  }

  refreshingPanel = true;

  try {
    if (panelID) {
      try {
        const old = await panelChannel.messages.fetch(panelID);
        await old.delete();
      } catch {}
    }

    const embed = new EmbedBuilder()
      .setTitle('🍩 Sistema de Ponches')
      .setDescription(
        'Registra tu jornada laboral desde este panel.\n\n' +
        'Solo los empleados contratados pueden usar entrada y salida.'
      )
      .setColor('#ff4bd1')
      .setImage('https://cdn.discordapp.com/attachments/1495631128139268206/1496470001928896623/IMG_4028.gif')
      .setFooter({ text: 'Sweet Holes Donuts | Control de Jornada' })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('entrada').setLabel('🟢 Entrada').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('salida').setLabel('🔴 Salida').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('horas').setLabel('⏱ Horas').setStyle(ButtonStyle.Primary)
    );

    const msg = await panelChannel.send({ embeds: [embed], components: [row] });
    panelID = msg.id;
  } finally {
    refreshingPanel = false;

    if (refreshPanelQueued) {
      refreshPanelQueued = false;
      refreshPanelDespues();
    }
  }
}

function refreshPanelDespues() {
  if (refreshPanelTimeout) clearTimeout(refreshPanelTimeout);

  refreshPanelTimeout = setTimeout(async () => {
    refreshPanelTimeout = null;
    await refreshPanel();
  }, 2500);
}

// ================= CONTRATACION =================
async function crearPanelContratacion(channel) {
  const embed = new EmbedBuilder()
    .setTitle('🧾 Centro de Contratación')
    .setDescription(
      'Selecciona un usuario para registrarlo como empleado.\n\n' +
      'Una vez contratado, podrá usar el panel de ponche y acumular horas en el ranking.'
    )
    .setColor('#9b59b6')
    .setImage('https://i.imgur.com/FTWRO4r.png')
    .setFooter({ text: 'Sweet Holes Donuts | Recursos Humanos' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('seleccionar_empleado')
      .setPlaceholder('Seleccionar empleado para contratar')
      .setMinValues(1)
      .setMaxValues(1)
  );

  await channel.send({ embeds: [embed], components: [row] });
}

// ================= REPORTES =================
function crearIdReporte(userId) {
  return `${Date.now()}_${userId}`;
}

async function crearEmbedReporte(report, guild, estado, staffMember = null) {
  const user = await client.users.fetch(report.userId).catch(() => null);
  const member = guild.members.cache.get(report.userId) || await guild.members.fetch(report.userId).catch(() => null);

  let color = '#f5b041';
  let estadoTexto = '⏳ Pendiente de revisión';

  if (estado === 'aprobado') {
    color = '#2ecc71';
    estadoTexto = '✅ Aprobado';
  }

  if (estado === 'rechazado') {
    color = '#e74c3c';
    estadoTexto = '❌ Rechazado';
  }

  const embed = new EmbedBuilder()
    .setTitle('📨 Solicitud de Inactividad')
    .setColor(color)
    .setThumbnail(user?.displayAvatarURL({ dynamic: true, size: 256 }) || null)
    .addFields(
      {
        name: '👤 Empleado',
        value: `${member || `<@${report.userId}>`}\n${member?.displayName || user?.username || 'Usuario desconocido'}`,
        inline: true
      },
      {
        name: '🆔 ID del empleado',
        value: report.userId,
        inline: true
      },
      {
        name: '⏱ Duración estimada',
        value: cortarTexto(report.tiempo, 100),
        inline: true
      },
      {
        name: '📝 Motivo',
        value: cortarTexto(report.razon, 1000),
        inline: false
      },
      {
        name: '📌 Estado',
        value: estadoTexto,
        inline: true
      },
      {
        name: '📅 Enviado',
        value: fechaDiscord(report.createdAt),
        inline: true
      }
    )
    .setFooter({ text: `Reporte ID: ${report.id}` })
    .setTimestamp();

  if (staffMember) {
    embed.addFields(
      {
        name: '🛡 Revisado por',
        value: `${staffMember}\n${staffMember.displayName}`,
        inline: true
      },
      {
        name: '🕒 Fecha de revisión',
        value: fechaDiscord(),
        inline: true
      }
    );
  }

  return embed;
}

function crearBotonesReporte(reportId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`aprobar_${reportId}`).setLabel('Aprobar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`rechazar_${reportId}`).setLabel('Rechazar').setStyle(ButtonStyle.Danger)
  );
}

async function avisarEmpleadoReporte(report, guild, estado, staffMember) {
  const user = await client.users.fetch(report.userId).catch(() => null);
  if (!user) return;

  const aprobado = estado === 'aprobado';

  const embed = new EmbedBuilder()
    .setTitle(aprobado ? '✅ Tu inactividad fue aprobada' : '❌ Tu inactividad fue rechazada')
    .setColor(aprobado ? '#2ecc71' : '#e74c3c')
    .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
    .addFields(
      { name: 'Servidor', value: guild.name, inline: true },
      { name: 'Duración', value: cortarTexto(report.tiempo, 100), inline: true },
      { name: 'Revisado por', value: staffMember.displayName, inline: true },
      { name: 'Motivo reportado', value: cortarTexto(report.razon, 1000), inline: false }
    )
    .setTimestamp();

  try {
    await user.send({ embeds: [embed] });
  } catch {}
}

// ================= PANEL INACTIVIDAD =================
async function refreshInactivityPanel() {
  if (!inactivityChannel || refreshingInactivityPanel) return;

  refreshingInactivityPanel = true;

  try {
    if (inactivityPanelID) {
      try {
        const old = await inactivityChannel.messages.fetch(inactivityPanelID);
        await old.delete();
      } catch {}
    }

    const embed = new EmbedBuilder()
      .setTitle('📋 Centro de Inactividad')
      .setDescription(
        'Reporta una ausencia para que el equipo administrativo pueda revisarla.\n\n' +
        'Cuando tu solicitud sea aprobada o rechazada, quedará registrado automáticamente quién la revisó.'
      )
      .setColor('#f5b041')
      .setImage('https://i.imgur.com/yNtX66r.jpg')
      .setFooter({ text: 'Sweet Holes Donuts | Sistema Administrativo' })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('reportar').setLabel('Reportar inactividad').setStyle(ButtonStyle.Primary)
    );

    const msg = await inactivityChannel.send({ embeds: [embed], components: [row] });
    inactivityPanelID = msg.id;
  } finally {
    refreshingInactivityPanel = false;
  }
}

async function mantenerPanelAbajo() {
  await refreshInactivityPanel();
}

// ================= RANKING =================
async function updateLeaderboard(guild) {
  const channel = guild.channels.cache.get(STATS_CHANNEL_ID);
  if (!channel) return;

  const empleados = Object.entries(db.empleados);

  const ranking = empleados
    .map(([userId, info]) => ({
      userId,
      info,
      horas: db.horas[userId] || 0
    }))
    .sort((a, b) => b.horas - a.horas)
    .slice(0, 10);

  let texto = '';

  ranking.forEach((item, i) => {
    const member = guild.members.cache.get(item.userId);
    const medal = ['🥇', '🥈', '🥉'][i] || '🔹';

    texto += `${medal} **${member?.displayName || 'Empleado'}**\n`;
    texto += `> 👤 <@${item.userId}>\n`;
    texto += `> ⏱ ${formatTiempo(item.horas)}\n\n`;
  });

  if (!texto) texto = 'Todavía no hay empleados con horas registradas.';

  const totalHorasServidor = empleados.reduce((acc, [id]) => acc + (db.horas[id] || 0), 0);

  const embed = new EmbedBuilder()
    .setTitle('🏆 Ranking Semanal de Empleados')
    .setDescription(texto)
    .addFields(
      { name: '👥 Empleados contratados', value: `${empleados.length}`, inline: true },
      { name: '⏱ Horas totales', value: formatTiempo(totalHorasServidor), inline: true },
      { name: '📅 Última actualización', value: fechaDiscord(), inline: false }
    )
    .setColor('#f1c40f')
    .setImage('https://i.imgur.com/FTWRO4r.png')
    .setFooter({ text: 'Sweet Holes Donuts | Ranking semanal' })
    .setTimestamp();

  try {
    if (db.rankingMessageId) {
      const old = await channel.messages.fetch(db.rankingMessageId);
      await old.edit({ embeds: [embed] });
      guardarDB();
      return;
    }
  } catch {}

  const msg = await channel.send({ embeds: [embed] });
  db.rankingMessageId = msg.id;
  guardarDB();
}

async function resetearRankingSemanal(guild) {
  for (const empleadoId of Object.keys(db.empleados)) {
    db.horas[empleadoId] = 0;
  }

  guardarDB();
  await updateLeaderboard(guild);
}

function iniciarRankingAutomatico() {
  setInterval(async () => {
    const ahora = new Date();
    const esLunes = ahora.getDay() === 1;
    const claveLunes = `${ahora.getFullYear()}-${ahora.getMonth() + 1}-${ahora.getDate()}`;

    if (!esLunes) return;
    if (db.lastMondayUpdate === claveLunes) return;

    const guild = client.guilds.cache.first();
    if (!guild) return;

    db.lastMondayUpdate = claveLunes;
    await resetearRankingSemanal(guild);

    guardarDB();
  }, 60 * 60 * 1000);
}

// ================= AFK =================
function startAFK(interaction, user) {
  if (timers[user]) {
    clearTimeout(timers[user]);
    delete timers[user];
  }

  timers[user] = setTimeout(async () => {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('seguir').setLabel('Sigo activo').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('afk_no').setLabel('Salir').setStyle(ButtonStyle.Danger)
    );

    let tiempoRestante = 180;

    try {
      const dm = await interaction.user.createDM();

      const msg = await dm.send({
        content: `⚠️ ¿Sigues trabajando?\n⏳ Tiempo restante: 03:00`,
        components: [row]
      });

      afkMessages[user] = msg;

      afkIntervals[user] = setInterval(async () => {
        tiempoRestante--;

        const min = Math.floor(tiempoRestante / 60);
        const sec = tiempoRestante % 60;
        const tiempoTexto = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

        if (tiempoRestante <= 0) {
          clearInterval(afkIntervals[user]);
          delete afkIntervals[user];

          try {
            await msg.edit({ content: '⛔ Tiempo agotado', components: [] });
          } catch {}

          if (data[user]) await autoSalida(interaction, user);
          return;
        }

        try {
          await msg.edit({
            content: `⚠️ ¿Sigues trabajando?\n⏳ Tiempo restante: ${tiempoTexto}`,
            components: [row]
          });
        } catch {}
      }, 1000);
    } catch {
      if (data[user]) await autoSalida(interaction, user);
    }
  }, AFK_TIME);
}

async function autoSalida(interaction, user) {
  if (!data[user]) return;

  if (intervals[user]) {
    clearInterval(intervals[user]);
    delete intervals[user];
  }

  if (timers[user]) {
    clearTimeout(timers[user]);
    delete timers[user];
  }

  if (afkIntervals[user]) {
    clearInterval(afkIntervals[user]);
    delete afkIntervals[user];
  }

  const guild = interaction.guild || client.guilds.cache.get(userGuilds[user]);
  const ch = guild?.channels.cache.get(AUTO_CHANNEL_ID);

  const embed = new EmbedBuilder()
    .setTitle('🚫 Turno Finalizado Automáticamente')
    .setDescription(
      `👤 <@${user}>\n\n` +
      `⚠️ No respondiste.\n📉 Inactividad detectada.\n❌ Tiempo no registrado.`
    )
    .setColor('#ff0000')
    .setImage('https://i.imgur.com/JTmf52O.png');

  delete data[user];

  if (ch) await ch.send({ embeds: [embed] });

  refreshPanelDespues();
}

// ================= INTERACCIONES =================
client.on('interactionCreate', async (interaction) => {
  const user = interaction.user.id;

  if (interaction.isUserSelectMenu() && interaction.customId === 'seleccionar_empleado') {
    if (!esStaff(interaction.member)) {
      return interaction.reply({ content: '❌ No tienes permiso para contratar empleados.', ephemeral: true });
    }

    const empleadoId = interaction.values[0];
    const empleado = await interaction.guild.members.fetch(empleadoId).catch(() => null);

    if (!empleado) {
      return interaction.reply({ content: '❌ No pude encontrar ese usuario.', ephemeral: true });
    }

    if (empleado.user.bot) {
      return interaction.reply({ content: '❌ No puedes contratar bots.', ephemeral: true });
    }

    if (db.empleados[empleadoId]) {
      return interaction.reply({ content: '❌ Ese usuario ya está contratado.', ephemeral: true });
    }

    db.empleados[empleadoId] = {
      contratadoPor: interaction.user.id,
      contratadoEn: Date.now()
    };

    if (!db.horas[empleadoId]) db.horas[empleadoId] = 0;

    guardarDB();

    const embed = new EmbedBuilder()
      .setTitle('✅ Empleado Contratado')
      .setColor('#2ecc71')
      .setThumbnail(empleado.user.displayAvatarURL({ dynamic: true, size: 256 }))
      .addFields(
        { name: '👤 Empleado', value: `${empleado}\n${empleado.displayName}`, inline: true },
        { name: '🛡 Contratado por', value: `${interaction.member}\n${interaction.member.displayName}`, inline: true },
        { name: '📅 Fecha', value: fechaDiscord(), inline: false },
        { name: '⏱ Horas iniciales', value: formatTiempo(db.horas[empleadoId]), inline: true }
      )
      .setFooter({ text: `ID empleado: ${empleadoId}` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });

    try {
      await empleado.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('✅ Has sido contratado')
            .setDescription('Ya puedes usar el panel de ponche para registrar tu jornada.')
            .setColor('#2ecc71')
            .setTimestamp()
        ]
      });
    } catch {}

    await updateLeaderboard(interaction.guild);
    return;
  }

  if (interaction.isButton() && interaction.customId === 'seguir') {
    if (afkIntervals[user]) {
      clearInterval(afkIntervals[user]);
      delete afkIntervals[user];
    }

    if (timers[user]) {
      clearTimeout(timers[user]);
      delete timers[user];
    }

    try {
      await interaction.message.edit({ components: [] });
    } catch {}

    startAFK(interaction, user);

    return interaction.reply({ content: '✅ Sigues activo', ephemeral: true });
  }

  if (interaction.isButton() && interaction.customId === 'afk_no') {
    if (afkIntervals[user]) {
      clearInterval(afkIntervals[user]);
      delete afkIntervals[user];
    }

    if (timers[user]) {
      clearTimeout(timers[user]);
      delete timers[user];
    }

    try {
      await interaction.message.edit({ components: [] });
    } catch {}

    if (intervals[user]) {
      clearInterval(intervals[user]);
      delete intervals[user];
    }

    if (!data[user]) {
      return interaction.reply({ content: '❌ Ya no estás en servicio', ephemeral: true });
    }

    const tiempoMs = Date.now() - data[user];
    const minutos = Math.floor(tiempoMs / 60000);
    const horas = Math.floor(minutos / 60);
    const minsRestantes = minutos % 60;
    const tiempoFinal = horas > 0 ? `${horas}h ${minsRestantes}m` : `${minsRestantes}m`;

    db.horas[user] = (db.horas[user] || 0) + (tiempoMs / 3600000);
    guardarDB();

    delete data[user];

    const guild = interaction.guild || client.guilds.cache.get(userGuilds[user]);
    const ch = guild?.channels.cache.get(AUTO_CHANNEL_ID);

    if (ch) {
      const embed = new EmbedBuilder()
        .setTitle('🔴 Salida automática AFK')
        .setDescription(`👤 <@${user}>\n\n⏱️ Tiempo trabajado:\n${tiempoFinal}`)
        .setColor('Red')
        .setImage('https://i.imgur.com/JTmf52O.png');

      await ch.send({ embeds: [embed] });
    }

    if (guild) await updateLeaderboard(guild);

    refreshPanelDespues();

    return interaction.reply({ content: '✅ Saliste de servicio', ephemeral: true });
  }

  if (interaction.isButton() && interaction.customId.startsWith('aprobar_')) {
    await interaction.deferReply({ ephemeral: true });

    if (!esStaff(interaction.member)) {
      return interaction.editReply({ content: '❌ No tienes permiso' });
    }

    const reportId = interaction.customId.replace('aprobar_', '');
    const report = inactivityReports[reportId];

    if (!report) {
      return interaction.editReply({ content: '❌ No encontré este reporte. Puede que el bot se haya reiniciado.' });
    }

    if (report.status !== 'pendiente') {
      return interaction.editReply({ content: '❌ Este reporte ya fue revisado.' });
    }

    report.status = 'aprobado';
    report.reviewedBy = interaction.user.id;
    report.reviewedAt = Date.now();

    const embed = await crearEmbedReporte(report, interaction.guild, 'aprobado', interaction.member);

    await interaction.message.edit({ embeds: [embed], components: [] });
    await avisarEmpleadoReporte(report, interaction.guild, 'aprobado', interaction.member);

    await interaction.editReply({ content: `✅ Reporte aprobado. Revisado por ${interaction.member.displayName}.` });

    return mantenerPanelAbajo();
  }

  if (interaction.isButton() && interaction.customId.startsWith('rechazar_')) {
    await interaction.deferReply({ ephemeral: true });

    if (!esStaff(interaction.member)) {
      return interaction.editReply({ content: '❌ No tienes permiso' });
    }

    const reportId = interaction.customId.replace('rechazar_', '');
    const report = inactivityReports[reportId];

    if (!report) {
      return interaction.editReply({ content: '❌ No encontré este reporte. Puede que el bot se haya reiniciado.' });
    }

    if (report.status !== 'pendiente') {
      return interaction.editReply({ content: '❌ Este reporte ya fue revisado.' });
    }

    report.status = 'rechazado';
    report.reviewedBy = interaction.user.id;
    report.reviewedAt = Date.now();

    const embed = await crearEmbedReporte(report, interaction.guild, 'rechazado', interaction.member);

    await interaction.message.edit({ embeds: [embed], components: [] });
    await avisarEmpleadoReporte(report, interaction.guild, 'rechazado', interaction.member);

    await interaction.editReply({ content: `❌ Reporte rechazado. Revisado por ${interaction.member.displayName}.` });

    return mantenerPanelAbajo();
  }

  if (interaction.isButton() && interaction.customId === 'entrada') {
    if (!estaContratado(user)) {
      await interaction.reply({
        content: '❌ No estás contratado en el sistema. Un staff debe contratarte primero.',
        ephemeral: true
      });

      refreshPanelDespues();
      return;
    }

    if (data[user]) {
      await interaction.reply({ content: '❌ Ya estás en servicio.', ephemeral: true });
      refreshPanelDespues();
      return;
    }

    data[user] = Date.now();
    userGuilds[user] = interaction.guild.id;

    startAFK(interaction, user);

    const embed = new EmbedBuilder()
      .setTitle('🟢 En Servicio')
      .setDescription(`${interaction.member.displayName}\n⏱️ Tiempo: 0m`)
      .setColor('Green')
      .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true, size: 256 }))
      .setImage('https://i.imgur.com/iy4wcni.png');

    const msg = await interaction.channel.send({ embeds: [embed] });

    intervals[user] = setInterval(async () => {
      if (!data[user]) {
        clearInterval(intervals[user]);
        delete intervals[user];
        return;
      }

      const tiempoMs = Date.now() - data[user];
      const minutos = Math.floor(tiempoMs / 60000);
      const horas = Math.floor(minutos / 60);
      const minsRestantes = minutos % 60;
      const tiempoTexto = horas > 0 ? `${horas}h ${minsRestantes}m` : `${minsRestantes}m`;

      embed.setDescription(`${interaction.member.displayName}\n⏱️ Tiempo: ${tiempoTexto}`);

      try {
        await msg.edit({ embeds: [embed] });
      } catch {}
    }, 60000);

    await interaction.deferUpdate();
    refreshPanelDespues();
    return;
  }

  if (interaction.isButton() && interaction.customId === 'salida') {
    if (intervals[user]) {
      clearInterval(intervals[user]);
      delete intervals[user];
    }

    if (!data[user]) {
      await interaction.reply({ content: '❌ No estás en servicio.', ephemeral: true });
      refreshPanelDespues();
      return;
    }

    const tiempoMs = Date.now() - data[user];
    const minutos = Math.floor(tiempoMs / 60000);
    const horas = Math.floor(minutos / 60);
    const minsRestantes = minutos % 60;
    const tiempoFinal = horas > 0 ? `${horas}h ${minsRestantes}m` : `${minsRestantes}m`;

    db.horas[user] = (db.horas[user] || 0) + (tiempoMs / 3600000);
    guardarDB();

    delete data[user];

    if (timers[user]) {
      clearTimeout(timers[user]);
      delete timers[user];
    }

    if (confirmTimers[user]) {
      clearTimeout(confirmTimers[user]);
      delete confirmTimers[user];
    }

    if (afkIntervals[user]) {
      clearInterval(afkIntervals[user]);
      delete afkIntervals[user];
    }

    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('🔴 Se fue de servicio')
          .setDescription(
            `👤 ${interaction.member.displayName}\n\n` +
            `📊 Tiempo trabajado:\n` +
            `⏱️ ${tiempoFinal}`
          )
          .setColor('Red')
          .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true, size: 256 }))
          .setImage('https://i.imgur.com/14hUy4X.png')
      ]
    });

    await interaction.deferUpdate();
    await updateLeaderboard(interaction.guild);

    refreshPanelDespues();
    return;
  }

  if (interaction.isButton() && interaction.customId === 'horas') {
    if (!esStaff(interaction.member)) {
      const horas = db.horas[user] || 0;

      return interaction.reply({
        content: `⏱️ Tus horas registradas esta semana: ${formatTiempo(horas)}`,
        ephemeral: true
      });
    }

    const empleados = Object.entries(db.empleados)
      .map(([id, info]) => ({
        id,
        info,
        horas: db.horas[id] || 0
      }))
      .sort((a, b) => b.horas - a.horas);

    let texto = '';

    empleados.forEach((empleado, i) => {
      const member = interaction.guild.members.cache.get(empleado.id);
      texto += `**${i + 1}. ${member?.displayName || 'Empleado'}**\n`;
      texto += `> 👤 <@${empleado.id}>\n`;
      texto += `> ⏱ ${formatTiempo(empleado.horas)}\n`;
      texto += `> 📅 Contratado: ${fechaDiscord(empleado.info.contratadoEn)}\n\n`;
    });

    if (!texto) texto = 'No hay empleados contratados todavía.';

    const embed = new EmbedBuilder()
      .setTitle('📊 Control de Horas Semanales')
      .setDescription(cortarTexto(texto, 4000))
      .setColor('#3498db')
      .setFooter({ text: `Solicitado por ${interaction.member.displayName}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (interaction.isButton() && interaction.customId === 'reportar') {
    const modal = new ModalBuilder()
      .setCustomId('modal_reporte')
      .setTitle('Solicitud de Inactividad');

    const razon = new TextInputBuilder()
      .setCustomId('razon')
      .setLabel('Motivo de la ausencia')
      .setPlaceholder('Ejemplo: cita médica, emergencia familiar, estudios...')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1000);

    const tiempo = new TextInputBuilder()
      .setCustomId('tiempo')
      .setLabel('Duración estimada')
      .setPlaceholder('Ejemplo: 2 horas, hoy completo, 3 días...')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);

    modal.addComponents(
      new ActionRowBuilder().addComponents(razon),
      new ActionRowBuilder().addComponents(tiempo)
    );

    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'modal_reporte') {
    const razon = interaction.fields.getTextInputValue('razon');
    const tiempo = interaction.fields.getTextInputValue('tiempo');

    const ch = interaction.guild.channels.cache.get(REPORT_CHANNEL_ID);
    const reportId = crearIdReporte(user);

    const report = {
      id: reportId,
      userId: user,
      guildId: interaction.guild.id,
      razon,
      tiempo,
      status: 'pendiente',
      createdAt: Date.now(),
      reviewedBy: null,
      reviewedAt: null
    };

    inactivityReports[reportId] = report;

    const embed = await crearEmbedReporte(report, interaction.guild, 'pendiente');
    const botones = crearBotonesReporte(reportId);

    if (ch) {
      const sent = await ch.send({
        content: `<@&${STAFF_ROLE_IDS[0]}> Nueva solicitud de inactividad pendiente.`,
        embeds: [embed],
        components: [botones]
      });

      report.messageId = sent.id;
      report.channelId = ch.id;
    }

    await interaction.reply({
      content: '✅ Tu solicitud de inactividad fue enviada correctamente. El staff la revisará pronto.',
      ephemeral: true
    });

    return mantenerPanelAbajo();
  }
});

// ================= COMANDOS =================
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;

  if (msg.content === '!panel') {
    panelChannel = msg.channel;
    await refreshPanel();
  }

  if (msg.content === '!inactividad') {
    inactivityChannel = msg.channel;
    await refreshInactivityPanel();
  }

  if (msg.content === '!contratacion') {
    if (!esStaff(msg.member)) return;
    await crearPanelContratacion(msg.channel);
  }

  if (msg.content === '!ranking') {
    if (!esStaff(msg.member)) return;
    await updateLeaderboard(msg.guild);
  }

  if (msg.content === '!resetranking') {
    if (!esStaff(msg.member)) return;
    await resetearRankingSemanal(msg.guild);
    await msg.reply('✅ Ranking semanal reiniciado manualmente.');
  }
});

client.once('ready', () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  iniciarRankingAutomatico();
});

client.login(process.env.TOKEN);
