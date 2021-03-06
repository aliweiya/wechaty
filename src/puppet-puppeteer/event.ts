/**
 *   Wechaty - https://github.com/chatie/wechaty
 *
 *   @copyright 2016-2018 Huan LI <zixia@zixia.net>
 *
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *   Unless required by applicable law or agreed to in writing, software
 *   distributed under the License is distributed on an "AS IS" BASIS,
 *   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *   See the License for the specific language governing permissions and
 *   limitations under the License.
 *
 */
import {
  WatchdogFood,
}                 from 'watchdog'

import {
  log,
}                 from '../config'
import {
  ScanData,
}                 from '../puppet/'

import PuppeteerContact from './puppeteer-contact'
import PuppeteerMessage from './puppeteer-message'

import Firer            from './firer'
import PuppetPuppeteer  from './puppet-puppeteer'
import {
  MsgType,
  MsgRawPayload,
}                       from './schema'

/* tslint:disable:variable-name */
export const Event = {
  onDing,

  onLog,
  onLogin,
  onLogout,

  onMessage,
  onScan,
  onUnload,

}

function onDing(
  this: PuppetPuppeteer,
  data: any,
): void {
  log.silly('PuppetPuppeteerEvent', 'onDing(%s)', data)
  this.emit('watchdog', { data })
}

async function onScan(
  this: PuppetPuppeteer,
  data: ScanData,
): Promise<void> {
  log.verbose('PuppetPuppeteerEvent', 'onScan({code: %d, url: %s})', data.code, data.url)

  if (this.state.off()) {
    log.verbose('PuppetPuppeteerEvent', 'onScan(%s) state.off()=%s, NOOP',
                                  data, this.state.off())
    return
  }

  this.scanInfo = data

  /**
   * When wx.qq.com push a new QRCode to Scan, there will be cookie updates(?)
   */
  await this.saveCookie()

  if (this.logonoff()) {
    log.verbose('PuppetPuppeteerEvent', 'onScan() there has user when got a scan event. emit logout and set it to null')
    await this.logout()
  }

  // feed watchDog a `scan` type of food
  const food: WatchdogFood = {
    data,
    type: 'scan',
  }
  this.emit('watchdog', food)
  this.emit('scan'    , data.url, data.code)
}

function onLog(data: any): void {
  log.silly('PuppetPuppeteerEvent', 'onLog(%s)', data)
}

async function onLogin(
  this: PuppetPuppeteer,
  note: string,
  ttl = 30,
): Promise<void> {
  log.verbose('PuppetPuppeteerEvent', 'onLogin(%s, %d)', note, ttl)

  const TTL_WAIT_MILLISECONDS = 1 * 1000
  if (ttl <= 0) {
    log.verbose('PuppetPuppeteerEvent', 'onLogin(%s) TTL expired')
    this.emit('error', new Error('TTL expired.'))
    return
  }

  if (this.state.off()) {
    log.verbose('PuppetPuppeteerEvent', 'onLogin(%s, %d) state.off()=%s, NOOP',
                                  note, ttl, this.state.off())
    return
  }

  this.scanInfo = undefined

  if (this.logonoff()) {
    log.warn('PuppetPuppeteerEvent', 'onLogin(%s) user had already set: "%s"', note, this.userSelf())
    await this.logout()
  }

  try {
    /**
     * save login user id to this.userId
     *
     * issue #772: this.bridge might not inited if the 'login' event fired too fast(because of auto login)
     */
    const userId = await this.bridge.getUserName()

    if (!userId) {
      log.verbose('PuppetPuppeteerEvent', 'onLogin() browser not fully loaded(ttl=%d), retry later', ttl)
      const html = await this.bridge.innerHTML()
      log.silly('PuppetPuppeteerEvent', 'onLogin() innerHTML: %s', html.substr(0, 500))
      setTimeout(onLogin.bind(this, note, ttl - 1), TTL_WAIT_MILLISECONDS)
      return
    }

    log.silly('PuppetPuppeteerEvent', 'bridge.getUserName: %s', userId)

    const user = PuppeteerContact.load(userId)
    user.puppet = this
    await user.ready()

    log.silly('PuppetPuppeteerEvent', `onLogin() user ${user.name()} logined`)

    try {
      if (this.state.on() === true) {
        await this.saveCookie()
      }
    } catch (e) { // fail safe
      log.verbose('PuppetPuppeteerEvent', 'onLogin() this.saveCookie() exception: %s', e.message)
    }

    // fix issue #668
    try {
      await this.readyStable()
    } catch (e) { // fail safe
      log.warn('PuppetPuppeteerEvent', 'readyStable() exception: %s', e && e.message || e)
    }

    this.login(user)
    // this.emit('login', user)

  } catch (e) {
    log.error('PuppetPuppeteerEvent', 'onLogin() exception: %s', e)
    throw e
  }

  return
}

async function onLogout(
  this: PuppetPuppeteer,
  data: any,
): Promise<void> {
  log.verbose('PuppetPuppeteerEvent', 'onLogout(%s)', data)

  if (this.logonoff()) {
    await this.logout()
  } else {
    // not logged-in???
    log.error('PuppetPuppeteerEvent', 'onLogout() without self-user')
  }
}

async function onMessage(
  this: PuppetPuppeteer,
  obj:  MsgRawPayload,
): Promise<void> {
  let m = new PuppeteerMessage(obj)
  m.puppet = this

  try {
    await m.ready()

    /**
     * Fire Events if match message type & content
     */
    switch (m.type()) {

      case MsgType.VERIFYMSG:
        Firer.checkFriendRequest.call(this, m)
        break

      case MsgType.SYS:
        if (m.room()) {
          const joinResult  = await Firer.checkRoomJoin.call(this  , m)
          const leaveResult = await Firer.checkRoomLeave.call(this , m)
          const topicRestul = await Firer.checkRoomTopic.call(this , m)

          if (!joinResult && !leaveResult && !topicRestul) {
            log.warn('PuppetPuppeteerEvent', `checkRoomSystem message: <${m.text()}> not found`)
          }
        } else {
          Firer.checkFriendConfirm.call(this, m)
        }
        break
    }

    /**
     * Check Type for special Message
     * reload if needed
     */

    switch (m.type()) {
      case MsgType.EMOTICON:
      case MsgType.IMAGE:
      case MsgType.VIDEO:
      case MsgType.VOICE:
      case MsgType.MICROVIDEO:
      case MsgType.APP:
        log.verbose('PuppetPuppeteerEvent', 'onMessage() EMOTICON/IMAGE/VIDEO/VOICE/MICROVIDEO message')
        m = new PuppeteerMessage(obj)
        m.puppet = this
        break

      case MsgType.TEXT:
        if (m.typeSub() === MsgType.LOCATION) {
          log.verbose('PuppetPuppeteerEvent', 'onMessage() (TEXT&LOCATION) message')
          m = new PuppeteerMessage(obj)
        }
        break
    }

    await m.ready()
    this.emit('message', m)

  } catch (e) {
    log.error('PuppetPuppeteerEvent', 'onMessage() exception: %s', e.stack)
    throw e
  }
}

async function onUnload(this: PuppetPuppeteer): Promise<void> {
  log.silly('PuppetPuppeteerEvent', 'onUnload()')
  /*
  try {
    await this.quit()
    await this.init()
  } catch (e) {
    log.error('PuppetPuppeteerEvent', 'onUnload() exception: %s', e)
    this.emit('error', e)
    throw e
  }
  */
}

export default Event
