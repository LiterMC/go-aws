
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
	auth?: D extends Function ? never : (D | ((ws: AWS) => D))
}

export default class AWS<D = unknown> extends EventTarget {
	private opts: Options<D>
	private _ws: WebSocket
	private _error: any = undefined
	private authTimeout: number = 10000
	private pingInterval: number = 15000
	private pongTimeout: number = 15000
	private _readyPromise: Promise<void>
	private _readyResolver: () => void
	private _writing: WrappedMsg[] = []
	private _senderId: ReturnType<typeof setTimeout> | null = null
	private _pingTicker: ReturnType<typeof setInterval> | null = null
	private _pongTimer: ReturnType<typeof setInterval> | null = null

	constructor(opts: Options<D>) {
		super()
		this.opts = opts
		this._ws = new WebSocket(this.opts.url, this.opts.protocols)
		this._readyResolver = () => {}
		this._readyPromise = new Promise((resolve, reject) => {
			this._readyResolver = () => resolve(undefined)
			setTimeout(() => reject('auth timeout'), this.authTimeout)
		}).then(() => {
			this._pingTicker = setInterval(() => {
				this.send('$ping', Date.now(), true)
			}, this.pingInterval)
		})

		this._ws.addEventListener('close', () => this.onWSClose())
		this._ws.addEventListener('message', (event: MessageEvent) => {
			const msgs = event.data.split('\n')
			for (const msg of msgs) {
				const msgTrimmed = msg.trim()
				if (msgTrimmed.length) {
					const { t: typ, d: data } = JSON.parse(msgTrimmed) as WrappedMsg;
					this.onMessage(typ, data);
				}
			}
		})
	}

	private reinitWS(): void {
		this._ws.close()
		this._ws = new WebSocket(this.opts.url, this.opts.protocols)
		this._readyPromise = new Promise((resolve, reject) => {
			const rejectTimer = setTimeout(() => reject('auth timeout'), this.authTimeout)
			this._readyResolver = () => {
				clearTimeout(rejectTimer)
				resolve()
			}
		})

		this._ws.addEventListener('close', () => this.onWSClose())
		this._ws.addEventListener('message', (event: MessageEvent) => {
			const msgs = event.data.split('\n')
			for (const msg of msgs) {
				const {t: typ, d: data} = JSON.parse(msg) as WrappedMsg
				this.onMessage(typ, data)
			}
		})
	}

	get ws(): WebSocket {
		return this._ws
	}

	ready(): Promise<void> {
		return this._readyPromise
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
			this._senderId = setTimeout(() => this.sendCachedMessages(), 20)
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
		if (this._pingTicker) {
			clearInterval(this._pingTicker)
			this._pingTicker = null
		}
		this.dispatchEvent(new AWSMessageEvent('$close', null))
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
			this._readyResolver()
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
		this._senderId = null
		let msgs = ''
		for (const msg of this._writing) {
			msgs += JSON.stringify(msg) + '\n'
		}
		this._writing = []
		this._ws.send(msgs)
	}
}
