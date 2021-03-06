const reload = require('require-reload')(require)
const EventEmitter = require('events')
const { getInfo } = require('ytdl-getinfo')
const GuildQueue = reload('./guildQueue')

/**
 * Guild Music Player
 */
class GuildPlayer extends EventEmitter {
  /**
   * Creates a new instance
   * @param {Discord.Guild} guild - The associated guild
   * @param {Azarasi.Guild} gData - Guild data
   * @param {object} qData - The queue data
   */
  constructor (guild, gData, qData) {
    super()
    /**
     * The associated guild
     * @type {Discord.Guild}
     */
    this.guild = guild
    /**
     * The Guild Data
     * @type {Azarasi.Guild}
     */
    this.guildData = gData
    /**
     * The AudioPlayer for this guild
     * @type {FocaBotCore.AudioPlayer}
     */
    this.audioPlayer = Core.AudioPlayer.getForGuild(guild)
    /**
     * The queue
     * @type {GuildQueue}
     */
    this.queue = this.guildData.queue || new GuildQueue(qData, this)
    this.guildData.queue = this.queue // Without this, weird things happen when i reload the module
    this.setMaxListeners(30)
  }

  /**
   * Starts playback
   * @param {boolean} silent - When set to true, no events will be emitted
   */
  async play (silent = false) {
    const s = await Core.settings.getForGuild(this.guild)
    const l = Core.locales.getLocale(s.locale)
    if (!this.queue.nowPlaying) return
    if (this.queue.nowPlaying.status === 'playing' && this.audioPlayer.currentStream) return
    const item = this.queue.nowPlaying
    try {
      const stream = await this.audioPlayer.play(
        item.voiceChannel,
        item.path,
        item.flags,
        item.time
      )
      // Set bot as self deafen
      // item.voiceChannel.join(false, true)
      item.status = 'playing'
      if (!silent) this.emit('playing', item)
      if (item.time === 0) this.emit('start', item)
      // Keep track of the time
      if (item.duration > 0) {
        this.timestampInt = setInterval(() => {
          try {
            if (this.queue._d.nowPlaying.uid !== item.uid) return
            this.queue.nowPlaying.time = this.audioPlayer.timestamp
          } catch (e) {}
        }, 1000)
      }
      this.fail = false
      // Handle stream end
      stream.on('end', () => {
        try {
          clearInterval(this.timestampInt)
        } catch (e) {}
        if (item.status === 'paused' || item.status === 'suspended') return
        this.emit('end', item)
        if (this.queue.loopMode === 'all') {
          this.queue._d.nowPlaying.time = 0
          this.refreshInfo(this.queue.nowPlaying)
          s.inversePlaylist ? this.queue._d.items.unshift(this.queue._d.nowPlaying)
                            : this.queue._d.items.push(this.queue._d.nowPlaying)
        }
        if (item.status === 'skipped') return
        if (this.queue.loopMode === 'single') {
          this.queue._d.nowPlaying.time = 0
          this.refreshInfo(this.queue.nowPlaying)
          return this.play()
        }
        if (!this.queue._d.items.length) return this.stop()
        if (this.queue._d.nowPlaying && item.uid !== this.queue.nowPlaying.uid) return
        this.queue._d.nowPlaying = s.inversePlaylist ? this.queue._d.items.pop()
                                                     : this.queue._d.items.shift()
        this.play()
      })
      if (!silent) this.queue.emit('updated')
    } catch (e) {
      Core.log(e, 2)
      if (!this.fail) item.textChannel.send(l.player.cantJoin)
      this.fail = true
      if (!this.queue._d.items.length) return this.stop()
      this.queue._d.nowPlaying = this.queue._d.items.shift()
      this.play()
    }
  }

  /**
   * Pauses playback
   * @param {boolean} silent - When set to true, no events will be emitted
   */
  async pause (silent = false) {
    const s = await Core.settings.getForGuild(this.guild)
    const l = Core.locales.getLocale(s.locale)
    const item = this.queue.nowPlaying
    // Can we pause?
    if (!item || item.stat) return
    if (item.status === 'paused' || item.status === 'suspended' || item.status === 'queue') return
    if (!isFinite(item.duration) || item.duration <= 0) throw new Error(l.player.noStreamPause)
    if (item.stat) throw new Error(l.player.noRestrictivePause)
    this.queue.nowPlaying.status = 'paused'
    this.audioPlayer.stop()
    if (!silent) this.emit('paused', item)
    if (!silent) this.queue.emit('updated')
  }

  /**
   * Suspends playback (pretty much the same as pause() but without the stream and filter checks)
   * @param {boolean} silent - When set to true, no events will be emitted
   */
  suspend (silent = false) {
    const item = this.queue.nowPlaying
    if (!item || item.stat) return
    if (item.status === 'paused' || item.status === 'suspended' || item.status === 'queue') return
    this.queue.nowPlaying.status = 'suspended'
    this.audioPlayer.stop()
    if (!silent) this.emit('suspended', item)
    if (!silent) this.queue.emit('updated')
  }

  /**
   * Hacky seek is still hacky
   * @param {number} time - Position to seek
   */
  async seek (time = 0) {
    const s = await Core.settings.getForGuild(this.guild)
    const l = Core.locales.getLocale(s.locale)
    const item = this.queue.nowPlaying
    if (!item) return
    if (item.stat) throw new Error(l.player.noRestrictiveSeek)
    if (item.duration <= 0) throw new Error(l.player.noStreamSeek)
    if (time > item.duration || time < 0) throw new Error(l.player.invalidSeek)
    const shouldResume = (item.status === 'playing')
    this.pause(true)
    item.time = time
    if (shouldResume) this.play(true)
    this.emit('seek', item, time)
  }

  /**
   * Changes the filters of the current item
   * @param {AudioFilter[]} newFilters - New filters
   */
  async updateFilters (newFilters) {
    const s = await Core.settings.getForGuild(this.guild)
    const l = Core.locales.getLocale(s.locale)
    const item = this.queue.nowPlaying
    if (!item) return
    if (item.stat) throw new Error(l.player.restrictiveFilters)
    if (item.duration <= 0) throw new Error(l.player.livestreamFilters)
    if (newFilters.filter(filter => filter.avoidRuntime).length) {
      throw new Error(l.player.restrictiveFiltersAdd)
    }
    const shouldResume = (item.status === 'playing')
    this.pause(true)
    item.filters = newFilters
    if (shouldResume) this.play(true)
    this.emit('filtersUpdated', item)
    this.queue.emit('updated')
  }

  /**
   * Refreshes video info in the background.
   * Used when the loop mode is enabled in order to keep the stream URL up to date.
   */
  async refreshInfo (item) {
    try {
      const info = await getInfo(item.sauce)
      if (!info.items[0]) throw new Error(`Couldn't refresh stream info for ${item.sauce}.`)
      item.path = info.items[0].url
    } catch (e) {
      Core.log(e, 2)
      item.error = true
    }
  }

  /**
   * Player Volume
   * @type {number}
   */
  get volume () {
    return this.queue._d.volume || 1
  }

  set volume (v) {
    let l
    try {
      l = Core.locales.getLocale(this.guildData.data.settings.locale || Core.properties.locale)
    } catch (e) {
      l = Core.locales.getLocale(Core.properties.locale)
    }
    const item = this.queue.nowPlaying
    if (item) {
      if (item.stat) throw new Error(l.player.restrictiveFilters)
      if (item.duration <= 0) throw new Error(l.player.noStreamVolume)
      const shouldResume = (item.status === 'playing')
      this.pause(true)
      this.queue._d.volume = v
      if (shouldResume) this.play(true)
      this.emit('filtersUpdated', item)
      this.queue.emit('updated')
    } else this.queue._d.volume = v
  }

  /**
   * Skips current item and starts playing the next one
   */
  async skip () {
    const s = await Core.settings.getForGuild(this.guild)
    const item = this.queue.nowPlaying
    if (!item && !this.queue._d.items.length) return
    item.status = 'skipped'
    if (!this.queue._d.items.length) return this.stop()

    this.audioPlayer.stop()
    this.queue._d.nowPlaying = s.inversePlaylist ? this.queue._d.items.pop()
                                                 : this.queue._d.items.shift()
    this.play()
    this.queue.emit('updated')
  }

  /**
   * Stops playback and clears the queue
   */
  stop () {
    this.queue.clear()
    this.audioPlayer.clean(true)
    this.queue._d.nowPlaying = undefined
    this.emit('stopped')
    this.queue.emit('updated')
  }
}

module.exports = GuildPlayer
