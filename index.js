require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

process.env.FFMPEG_PATH = ffmpegPath;

// ─── YouTube via youtubei.js (API interne YouTube) ────────────────────────────

let _youtube = null;
async function getYoutube() {
  if (!_youtube) {
    const { Innertube } = await import('youtubei.js');
    _youtube = await Innertube.create({ retrieve_player: false });
  }
  return _youtube;
}

// ─── État global du lecteur (un par serveur) ─────────────────────────────────

const players = new Map(); // guildId → MusicState

function getState(guildId) {
  if (!players.has(guildId)) {
    players.set(guildId, {
      queue: [],          // [{ title, url, duration, thumbnail, requestedBy }]
      currentIndex: -1,
      player: createAudioPlayer(),
      connection: null,
      panelMessage: null, // le message avec les boutons
    });

    const state = players.get(guildId);

    state.player.on(AudioPlayerStatus.Idle, () => playNext(guildId));
    state.player.on('error', err => {
      console.error('[Music] Erreur player:', err.message);
      playNext(guildId);
    });
  }
  return players.get(guildId);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(sec) {
  if (!sec) return '🔴 Live';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function isUrl(str) {
  return /^https?:\/\//.test(str);
}

function cleanYoutubeUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com') && u.searchParams.has('v')) {
      return `https://www.youtube.com/watch?v=${u.searchParams.get('v')}`;
    }
    if (u.hostname.includes('youtu.be')) {
      return `https://www.youtube.com/watch?v=${u.pathname.slice(1).split('?')[0]}`;
    }
  } catch {}
  return url;
}

// ─── Récupérer les infos d'une vidéo via youtubei.js ─────────────────────────

async function fetchTrack(query, requestedBy) {
  const yt = await getYoutube();
  let videoId, title, duration, thumbnail;

  if (isUrl(query)) {
    const clean = cleanYoutubeUrl(query);
    videoId = new URL(clean).searchParams.get('v');
    if (!videoId) throw new Error('URL YouTube invalide.');
    const info = await yt.getBasicInfo(videoId, 'ANDROID');
    title = info.basic_info.title;
    duration = info.basic_info.duration ?? 0;
    thumbnail = info.basic_info.thumbnail?.[0]?.url ?? null;
  } else {
    const search = await yt.search(query, { type: 'video' });
    const video = search.videos?.[0];
    if (!video) throw new Error('Aucun résultat trouvé.');
    videoId = video.id;
    title = video.title?.text ?? 'Titre inconnu';
    duration = video.duration?.seconds ?? 0;
    thumbnail = video.thumbnails?.[0]?.url ?? null;
  }

  return { title, videoId, url: `https://www.youtube.com/watch?v=${videoId}`, duration, thumbnail, requestedBy };
}

// ─── Rejoindre le salon vocal ─────────────────────────────────────────────────

async function joinChannel(state, voiceChannel) {
  if (
    state.connection &&
    state.connection.state.status !== VoiceConnectionStatus.Destroyed &&
    state.connection.joinConfig.channelId === voiceChannel.id
  ) return;

  const conn = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 15_000);
  } catch {
    conn.destroy();
    throw new Error('Impossible de rejoindre le salon vocal.');
  }

  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
        entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      stopPlayer(voiceChannel.guild.id);
    }
  });

  conn.subscribe(state.player);
  state.connection = conn;
}

// ─── Jouer un morceau ─────────────────────────────────────────────────────────

async function playTrack(guildId, track) {
  const state = getState(guildId);
  try {
    const yt = await getYoutube();
    const info = await yt.getBasicInfo(track.videoId, 'ANDROID');
    const format = info.chooseFormat({ type: 'audio', quality: 'best' });
    if (!format?.url) throw new Error('Aucun format audio disponible.');

    const ffmpeg = spawn(ffmpegPath, [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', format.url,
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1',
    ]);

    ffmpeg.stderr.on('data', () => {});
    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
    state.player.play(resource);
    await updatePanel(guildId);
  } catch (err) {
    console.error('[Music] Erreur stream:', err.message);
    playNext(guildId);
  }
}

// ─── Passer au suivant automatiquement ───────────────────────────────────────

async function playNext(guildId) {
  const state = getState(guildId);
  if (state.currentIndex < state.queue.length - 1) {
    state.currentIndex++;
    await playTrack(guildId, state.queue[state.currentIndex]);
  } else {
    await updatePanel(guildId);
  }
}

// ─── Arrêter complètement ─────────────────────────────────────────────────────

function stopPlayer(guildId) {
  const state = players.get(guildId);
  if (!state) return;
  state.queue = [];
  state.currentIndex = -1;
  state.player.stop(true);
  if (state.connection) {
    try { state.connection.destroy(); } catch {}
    state.connection = null;
  }
  updatePanel(guildId);
}

// ─── Construire l'embed du panneau ───────────────────────────────────────────

function buildEmbed(guildId) {
  const state = getState(guildId);
  const track = state.queue[state.currentIndex] ?? null;
  const embed = new EmbedBuilder().setColor(0x5865F2).setTimestamp();

  if (!track) {
    return embed
      .setTitle('🎵 Lecteur Musical')
      .setDescription(
        '> Aucune musique en cours de lecture.\n\n' +
        '**Commandes :**\n' +
        '`!play <lien YouTube ou recherche>` — Ajouter et lancer\n' +
        '`!queue` — Voir la file d\'attente\n' +
        '`!stop` — Stopper et déconnecter'
      );
  }

  const isPaused = state.player.state.status === AudioPlayerStatus.Paused;
  const statusLabel = isPaused ? '⏸ En pause' : '▶️ En lecture';
  const nextTrack = state.queue[state.currentIndex + 1] ?? null;

  embed
    .setTitle(`${statusLabel}`)
    .setDescription(`**[${track.title}](${track.url})**`)
    .addFields(
      { name: '⏱ Durée', value: formatDuration(track.duration), inline: true },
      { name: '👤 Demandé par', value: track.requestedBy, inline: true },
      { name: '📋 File', value: `${state.currentIndex + 1} / ${state.queue.length}`, inline: true }
    );

  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  if (nextTrack) embed.addFields({ name: '⏭ Suivant', value: nextTrack.title });

  return embed;
}

// ─── Construire les boutons ───────────────────────────────────────────────────

function buildButtons(guildId) {
  const state = getState(guildId);
  const track = state.queue[state.currentIndex] ?? null;
  const isPaused = state.player.state.status === AudioPlayerStatus.Paused;
  const hasPrev = state.currentIndex > 0;
  const hasNext = state.currentIndex < state.queue.length - 1;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_previous')
      .setLabel('⏮ Précédent')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasPrev),
    new ButtonBuilder()
      .setCustomId('music_pause_resume')
      .setLabel(isPaused ? '▶ Reprendre' : '⏸ Pause')
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary)
      .setDisabled(!track),
    new ButtonBuilder()
      .setCustomId('music_skip')
      .setLabel('⏭ Suivant')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasNext),
    new ButtonBuilder()
      .setCustomId('music_stop')
      .setLabel('⏹ Stop')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!track),
  );
}

// ─── Mettre à jour le panneau de contrôle ────────────────────────────────────

async function updatePanel(guildId) {
  const state = getState(guildId);
  if (!state.panelMessage) return;
  try {
    await state.panelMessage.edit({
      embeds: [buildEmbed(guildId)],
      components: [buildButtons(guildId)],
    });
  } catch (err) {
    console.error('[Music] Erreur mise à jour panneau:', err.message);
    state.panelMessage = null;
  }
}

// ─── Envoyer ou réutiliser le panneau dans le salon configuré ────────────────

async function ensurePanel(guildId, fallbackChannel) {
  const state = getState(guildId);

  // Tenter de modifier le message existant
  if (state.panelMessage) {
    try {
      await state.panelMessage.edit({
        embeds: [buildEmbed(guildId)],
        components: [buildButtons(guildId)],
      });
      return;
    } catch {
      state.panelMessage = null;
    }
  }

  // Chercher le salon panel configuré, sinon utiliser le salon de la commande
  let panelChannel = fallbackChannel;
  if (process.env.MUSIC_PANEL_CHANNEL_ID) {
    const configured = fallbackChannel.guild.channels.cache.get(process.env.MUSIC_PANEL_CHANNEL_ID);
    if (configured) panelChannel = configured;
  }

  state.panelMessage = await panelChannel.send({
    embeds: [buildEmbed(guildId)],
    components: [buildButtons(guildId)],
  });
}

// ─── Client Discord ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── Commandes texte ──────────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const args = message.content.trim().split(/\s+/);
  const cmd = args[0].toLowerCase();

  // ── !play ─────────────────────────────────────────────────────────────────
  if (cmd === '!play') {
    const query = args.slice(1).join(' ');
    if (!query) {
      return message.reply('❌ Utilisation : `!play <lien YouTube ou recherche>`');
    }

    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      return message.reply('❌ Tu dois être dans un salon vocal pour utiliser cette commande.');
    }

    const loadingMsg = await message.reply('🔍 Recherche en cours...');
    const state = getState(message.guild.id);

    let track;
    try {
      track = await fetchTrack(query, message.author.username);
    } catch (err) {
      return loadingMsg.edit(`❌ Erreur : ${err.message}`);
    }

    const wasIdle =
      state.queue.length === 0 ||
      state.player.state.status === AudioPlayerStatus.Idle;

    state.queue.push(track);

    try {
      await joinChannel(state, voiceChannel);
    } catch (err) {
      state.queue.pop();
      return loadingMsg.edit(`❌ ${err.message}`);
    }

    if (wasIdle || state.currentIndex < 0) {
      state.currentIndex = state.queue.length - 1;
      await playTrack(message.guild.id, track);
      await loadingMsg.edit(`▶️ Lecture de **${track.title}**`);
    } else {
      await loadingMsg.edit(`✅ Ajouté à la file (position ${state.queue.length}) : **${track.title}**`);
      await updatePanel(message.guild.id);
    }

    await ensurePanel(message.guild.id, message.channel);
    return;
  }

  // ── !queue ────────────────────────────────────────────────────────────────
  if (cmd === '!queue') {
    const state = getState(message.guild.id);
    if (!state.queue.length) {
      return message.reply('📋 La file d\'attente est vide.');
    }

    const lines = state.queue.map((t, i) => {
      const current = i === state.currentIndex ? '▶️ ' : `${i + 1}. `;
      return `${current}**${t.title}** — ${formatDuration(t.duration)}`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📋 File d\'attente')
      .setDescription(lines.slice(0, 20).join('\n'))
      .setFooter({ text: `${state.queue.length} morceau(x) au total` });

    return message.reply({ embeds: [embed] });
  }

  // ── !skip ─────────────────────────────────────────────────────────────────
  if (cmd === '!skip') {
    const state = getState(message.guild.id);
    if (state.currentIndex >= state.queue.length - 1) {
      return message.reply('❌ Pas de morceau suivant dans la file.');
    }
    state.currentIndex++;
    await playTrack(message.guild.id, state.queue[state.currentIndex]);
    return message.reply(`⏭ Passage au suivant : **${state.queue[state.currentIndex].title}**`);
  }

  // ── !previous / !prev ─────────────────────────────────────────────────────
  if (cmd === '!previous' || cmd === '!prev') {
    const state = getState(message.guild.id);
    if (state.currentIndex <= 0) {
      return message.reply('❌ Pas de morceau précédent.');
    }
    state.currentIndex--;
    await playTrack(message.guild.id, state.queue[state.currentIndex]);
    return message.reply(`⏮ Retour à : **${state.queue[state.currentIndex].title}**`);
  }

  // ── !pause ────────────────────────────────────────────────────────────────
  if (cmd === '!pause') {
    const state = getState(message.guild.id);
    if (state.player.state.status !== AudioPlayerStatus.Playing) {
      return message.reply('❌ Aucune musique en cours de lecture.');
    }
    state.player.pause();
    await updatePanel(message.guild.id);
    return message.reply('⏸ Musique mise en pause.');
  }

  // ── !resume ───────────────────────────────────────────────────────────────
  if (cmd === '!resume') {
    const state = getState(message.guild.id);
    if (state.player.state.status !== AudioPlayerStatus.Paused) {
      return message.reply('❌ La musique n\'est pas en pause.');
    }
    state.player.unpause();
    await updatePanel(message.guild.id);
    return message.reply('▶️ Lecture reprise.');
  }

  // ── !stop ─────────────────────────────────────────────────────────────────
  if (cmd === '!stop') {
    const state = getState(message.guild.id);
    if (!state.connection) {
      return message.reply('❌ Le bot n\'est pas connecté à un salon vocal.');
    }
    stopPlayer(message.guild.id);
    return message.reply('⏹ Musique arrêtée et bot déconnecté.');
  }

  // ── Auto-play : lien YouTube collé directement ────────────────────────────
  const YOUTUBE_REGEX = /https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|shorts\/|playlist\?)|youtu\.be\/)[^\s]+/;
  const youtubeMatch = message.content.match(YOUTUBE_REGEX);

  if (youtubeMatch) {
    // Si MUSIC_REQUEST_CHANNEL_ID est défini, ne réagir que dans ce salon
    if (
      process.env.MUSIC_REQUEST_CHANNEL_ID &&
      message.channelId !== process.env.MUSIC_REQUEST_CHANNEL_ID
    ) return;

    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      return message.reply('❌ Rejoins un salon vocal pour que je puisse jouer ce lien !');
    }

    const url = cleanYoutubeUrl(youtubeMatch[0]);
    const loadingMsg = await message.reply('🔍 Chargement du lien...');
    const state = getState(message.guild.id);

    let track;
    try {
      track = await fetchTrack(url, message.author.username);
    } catch (err) {
      return loadingMsg.edit(`❌ Erreur : ${err.message}`);
    }

    const wasIdle =
      state.queue.length === 0 ||
      state.player.state.status === AudioPlayerStatus.Idle;

    state.queue.push(track);

    try {
      await joinChannel(state, voiceChannel);
    } catch (err) {
      state.queue.pop();
      return loadingMsg.edit(`❌ ${err.message}`);
    }

    if (wasIdle || state.currentIndex < 0) {
      state.currentIndex = state.queue.length - 1;
      await playTrack(message.guild.id, track);
      await loadingMsg.edit(`▶️ Lecture de **${track.title}**`);
    } else {
      await loadingMsg.edit(`✅ Ajouté à la file (position ${state.queue.length}) : **${track.title}**`);
      await updatePanel(message.guild.id);
    }

    await ensurePanel(message.guild.id, message.channel);
  }
});

// ─── Interactions boutons ─────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('music_')) return;

  await interaction.deferUpdate();

  const guildId = interaction.guildId;
  const state = getState(guildId);

  switch (interaction.customId) {
    case 'music_previous': {
      if (state.currentIndex > 0) {
        state.currentIndex--;
        await playTrack(guildId, state.queue[state.currentIndex]);
      }
      break;
    }
    case 'music_pause_resume': {
      if (state.player.state.status === AudioPlayerStatus.Playing) {
        state.player.pause();
      } else if (state.player.state.status === AudioPlayerStatus.Paused) {
        state.player.unpause();
      }
      await updatePanel(guildId);
      break;
    }
    case 'music_skip': {
      if (state.currentIndex < state.queue.length - 1) {
        state.currentIndex++;
        await playTrack(guildId, state.queue[state.currentIndex]);
      }
      break;
    }
    case 'music_stop': {
      stopPlayer(guildId);
      break;
    }
  }
});

// ─── Démarrage ────────────────────────────────────────────────────────────────

client.once('clientReady', () => {
  console.log(`✅ Bot musique connecté : ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
