interface WrappedMsg {
	t: string
	d: any
}

interface ReadyMessage {
	pingInterval: number
	pongTimeout: number
}

export class AWSMessageEvent<T = unknown> extends Event {
	readonly data: T

	constructor(type: string, data: T) {
		super(type, { cancelable: true })
		this.data = data
	}
}

export type Listener<T = any> = (msg: MessageEvent<T>) => void

export interface Options<D = unknown> {
	url: string | URL
	protocols?: string | string[]
	auth?: D extends Function ? never : D | ((ws: AWS) => D)
}

export default class AWS<D = unknown> extends EventTarget {
	private opts: Options<D>
	private _shouldActive: boolean = true
	private _ws: WebSocket
	private _error: any = undefined
	private authTimeout: number = 10000
	private pingInterval: number = 15000
	private pongTimeout: number = 15000
	private _readyPromise: Promise<void>
	private _readyResolver: () => void = () => {}
	private _readyRejector: (err: any) => void = () => {}
	private _writing: WrappedMsg[] = []
	private _senderId: ReturnType<typeof setTimeout> | null = null
	private _pingTicker: ReturnType<typeof setInterval> | null = null
	private _pongTimer: ReturnType<typeof setInterval> | null = null
	private redialCount: number = 0
	private redialTimer: ReturnType<typeof setTimeout> | null = null

	constructor(opts: Options<D>) {
		super()
		this.opts = opts
		this._ws = new WebSocket(this.opts.url, this.opts.protocols)
		this._ws.addEventListener('close', () => this.onWSClose())
		this._ws.addEventListener('message', (event) => this.onWSMessage(event))

		this._readyPromise = this._createReadyPromise()
	}

	private _createReadyPromise(): Promise<void> {
		return new Promise((resolve, reject) => {
			const rejectTimer = setTimeout(() => reject('auth timeout'), this.authTimeout)
			this._readyResolver = () => {
				clearTimeout(rejectTimer)
				resolve(undefined)
			}
			this._readyRejector = (err: any) => {
				clearTimeout(rejectTimer)
				reject(err)
			}
		})
	}

	private reopenWS(): void {
		if (this._ws.readyState !== WebSocket.CLOSING && this._ws.readyState !== WebSocket.CLOSED) {
			throw new Error('Trying to reconnect the websocket that has not been disconnected')
		}
		clearTimeout(this.redialTimer)
		this.redialTimer = null
		this.redialCount++
		this._ws = new WebSocket(this.opts.url, this.opts.protocols)
		this._ws.addEventListener('close', () => this.onWSClose())
		this._ws.addEventListener('message', (event) => this.onWSMessage(event))

		this._readyPromise = this._createReadyPromise()
	}

	get ws(): WebSocket {
		return this._ws
	}

	get shouldActive(): boolean {
		return this._shouldActive
	}

	ready(): Promise<void> {
		return this._readyPromise
	}

	open(): void {
		this._shouldActive = true
		this.reopenWS()
	}

	close(): void {
		this._shouldActive = false
		this._ws.close()
	}

	on<T = any>(event: string, listener: Listener<T>, options?: AddEventListenerOptions) {
		this.addEventListener(event, listener, options)
	}

	off<T = unknown>(event: string, listener: Listener<T>, options?: EventListenerOptions) {
		this.removeEventListener(event, listener, options)
	}

	send(event: string, data: any, immediately?: boolean) {
		this._writing.push({
			t: event,
			d: data,
		})
		if (immediately) {
			if (this._senderId) {
				clearTimeout(this._senderId)
				this._senderId = null
			}
			this.sendCachedMessages()
		} else if (!this._senderId) {
			this._senderId = setTimeout(() => {
				this._senderId = null
				this.sendCachedMessages()
			}, 20)
		}
	}

	private onMessage(typ: string, data: any) {
		clearTimeout(this._pongTimer)
		this._pongTimer = setTimeout(() => this.onPingTimeout(), this.pingInterval + this.pongTimeout)
		if (!this.dispatchEvent(new AWSMessageEvent(typ, data))) {
			return
		}
		if (typ[0] === '$') {
			this.onInternalMessage(typ, data)
			return
		}
	}

	private onWSClose(): void {
		this._readyRejector('websocket closed')
		if (this._pingTicker) {
			clearInterval(this._pingTicker)
			this._pingTicker = null
		}
		this.dispatchEvent(new AWSMessageEvent('$close', null))
		if (!this._shouldActive) {
			return
		}
		const redialTimeout =
			this.redialCount == 0 ? 0 : Math.min(1000 * 1.6 ** this.redialCount, 1000 * 60)
		this.redialTimer = setTimeout(() => this.reopenWS(), redialTimeout)
	}

	private onWSMessage(event: MessageEvent): void {
		const msgs = event.data.split('\n')
		for (const msg of msgs) {
			const msgTrimmed = msg.trim()
			if (msgTrimmed.length) {
				const { t: typ, d: data } = JSON.parse(msgTrimmed) as WrappedMsg
				this.onMessage(typ, data)
			}
		}
	}

	private onInternalMessage(typ: string, data: any) {
		switch (typ) {
			case '$ping':
				this.send('$pong', data, true)
				break
			case '$pong':
				break
			case '$error':
				this._error = data
				break
			case '$auth_ready':
				this.doAuth()
				break
			case '$auth':
				// server side message
				break
			case '$ready':
				const readyData = data as ReadyMessage
				this.pingInterval = readyData.pingInterval
				this.pongTimeout = readyData.pongTimeout
				this._pingTicker = setInterval(() => {
					this.send('$ping', Date.now(), true)
				}, this.pingInterval)
				this._readyResolver()
				this.sendCachedMessages()
				break
		}
	}

	private doAuth(): void {
		if (this.opts.auth === undefined) {
			throw new Error('options.auth is not defined')
		}
		const auth = this.opts.auth
		const authData = typeof auth === 'function' ? auth(this) : auth
		this.send('$auth', authData, true)
	}

	private onPingTimeout(): void {
		this.send('$error', 'ping timeout', true)
		this._ws.close()
	}

	private sendCachedMessages(): void {
		if (this._ws.readyState !== WebSocket.OPEN) {
			if (this._ws.readyState !== WebSocket.CONNECTING) {
				this._writing = []
			}
			return
		}
		let msgs = ''
		for (const msg of this._writing) {
			msgs += JSON.stringify(msg) + '\n'
		}
		this._writing = []
		this._ws.send(msgs)
	}
}
