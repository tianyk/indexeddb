namespace idb {
	/**
	 * 数据库异常
	 */
	class DatabaseError extends Error {
		constructor(msg: string, err?: Error) {
			super(msg);
			this.name = this.constructor.name;

			if (err instanceof Error) {
				this.stack = this.stack + `\n\t-----------------\n\t${err.stack}`;
			}
		}
	}

	/**
	 * 索引异常
	 */
	class DatabaseIndexError extends DatabaseError {
		constructor() {
			super('Miss index');
		}
	}

	/**
	 * 超时错误
	 */
	class DatabaseTimeoutError extends DatabaseError {
	}

	class TimeoutError extends Error {
		constructor(timeout: number) {
			super(`Timeout ${timeout}`);
			this.name = this.constructor.name;
		}
	}

	function errorWrapper(err: string | Error): DatabaseError {
		if (err instanceof DatabaseError) {
			return err;
		} else if (typeof err === 'string') {
			return new DatabaseError(err);
		} else if (err instanceof Error) {
			return new DatabaseError(`${err.name}: ${err.message}`, err);
		} else {
			return new DatabaseError(JSON.stringify(err));
		}
	}

	/**
	 * 执行超时执行
	 *
	 * @param time - 超时时间
	 */
	function timeout(time: number): Promise<any> {
		return new Promise((resolve, reject) => {
			setTimeout(() => {
				reject(new TimeoutError(time));
			}, time);
		});
	}

	/**
	 * 判断是否为 `null`
	 * 
	 * @param val 
	 */
	function isNull(val: any): Boolean {
		return val === null;
	}

	/**
	 * 判断是否为 `undefined`
	 * 
	 * @param val 
	 */
	function isUndefined(val: any): Boolean {
		return typeof val === 'undefined';
	}

	/**
	 * Checks if value is null or undefined.
	 *
	 * @param {*} val
	 */
	function isNil(val: any): Boolean {
		return isNull(val) || isUndefined(val);
	}

	// 数据库名
	const DATABASE = 'idb';
	// version 勿动
	const DATABASE_VERSION = 1;
	/**
	 * 超时时间
	 */
	const OPEN_DB_TIMEOUT = 5 * 1000;
	/**
	 * stores
	 */
	enum IDB_STORENAMES {
		IMAGE_MAP = 'image_map'
	};


	/**
	 * db 状态
	 */
	enum IDBDatabaseState {
		OPEN,
		CLOSING,
		CLOSED
	};

	/**
	 * 位图
	 */
	interface ImageMap {
		id?: number;
		/**
		 * 行
		 */
		row: number;
		/**
		 * 列
		 */
		col: number;
		/**
		 * 位图数据
		 */
		data: ImageData | ArrayBuffer;
	}

	interface QueryParam {
		row?: number;
		col?: number;
	}

	interface QueryOptions {
		transaction?: IDBTransaction;
	}

	function debug(...arg: any[]) {
		console.debug(...arg);
	}

	/**
	 * 检查 DB 活跃
	 * 
	 * @param db 
	 */
	function isActive(db: IDBDatabase): Boolean {
		return (db as any).state === IDBDatabaseState.OPEN;
	}


	function request2promise<T>(request: IDBRequest): Promise<T> {
		return new Promise((resolve, reject) => {
			request.addEventListener('error', () => {
				const err = request.error;
				if (err && err.name === 'InvalidStateError') {
					request.transaction?.db.close();
				}
				reject(err);
			});
			request.addEventListener('success', () => resolve(request.result));
		});
	}

	function transaction2promise(tx: IDBTransaction): Promise<void> {
		return new Promise((resolve, reject) => {
			tx.addEventListener('complete', () => resolve());
			tx.addEventListener('error', (evt) => {
				const request = evt.target as IDBRequest;
				const err = request.error;
				if (err && err.name === 'InvalidStateError') {
					tx.db.close();
				}
				reject(err);
			});
			tx.addEventListener('abort', () => {
				reject(new DatabaseError('Transaction aborted'));
			});
		});
	}

	/**
	 * 初始化并打开 db 
	 * 
	 * @see https://developer.mozilla.org/en-US/docs/Web/API/IDBFactory/open
	 * @see https://github.com/jakearchibald/idb/issues/201
	 */
	export async function open(): Promise<IDBDatabase> {
		debug('opendb');
		const indexedDB = window.indexedDB;
		if (!indexedDB) {
			throw new DatabaseError('浏览器不支持 indexedDB');
		}

		return new Promise((resolve, reject) => {
			// 不要轻易改 version 
			const request = indexedDB.open(DATABASE, DATABASE_VERSION);

			request.onerror = function () {
				debug('open.onerror');
				reject(request.error);
			}

			request.onblocked = function () {
				debug('open.onblocked');
				reject(new DatabaseError('IDB Blocked'));
			}

			request.onsuccess = function () {
				debug('open.onsuccess');
				const db = request.result;
				const originClose = db.close.bind(db);
				// 重写 close 包含状态管理
				db.close = () => {
					debug('closedb');
					(db as any).state = IDBDatabaseState.CLOSING;
					originClose();
					(db as any).state = IDBDatabaseState.CLOSED;
				}

				// db 状态管理
				(db as any).state = IDBDatabaseState.OPEN;
				// .close 并不会触发 close 
				// 只有异常才会触发 close 事件
				// https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/onclose
				db.addEventListener('close', () => {
					debug('dbclosed');
					(db as any).state = IDBDatabaseState.CLOSED;
				});

				resolve(db);
			}

			request.onupgradeneeded = function (evt) {
				debug('onupgradeneeded', evt);
				// 初始化表结构时需要关注这里
				// 首次和升级时间都会触发
				// 在这里完成 store 的升级和创建
				// 类似数据库升级 
				// 必须在这里先创建或者修改表结构
				// 完成后触发 onsuccess 
				// 在 onsuccess 开启 transaction 拿到 store 
				const db = request.result;
				const upgradeTransaction = request.transaction || db.transaction(Array.from(db.objectStoreNames), 'readwrite');
				let imageMapStore: IDBObjectStore;

				// 初始化 DB 勿动 
				// 同一个 createObjectStore 只允许创建一次
				if (!db.objectStoreNames.contains(IDB_STORENAMES.IMAGE_MAP)) {
					imageMapStore = db.createObjectStore(IDB_STORENAMES.IMAGE_MAP, {
						keyPath: 'id',
						autoIncrement: true
					});
				} else {
					imageMapStore = upgradeTransaction.objectStore(IDB_STORENAMES.IMAGE_MAP);
				}

				if (!imageMapStore.indexNames.contains('idx_row_col')) {
					imageMapStore.createIndex('idx_row_col', ['row', 'col'], { unique: true });
				}
			}
		})
	}


	/**
	 * 获取一个 db 单例
	 */
	const getSingletonDB = (() => {
		let db: IDBDatabase | undefined;
		return async () => {
			if (db && isActive(db)) {
				debug('db.isActive');
				return db;
			}
			db = undefined;

			try {
				const now = Date.now();
				const _db: IDBDatabase = await Promise.race([
					timeout(OPEN_DB_TIMEOUT),
					open()
				]);

				if (db && isActive(db)) {
					_db.close();
				} else {
					db = _db;
				}

				debug('open db time', Date.now() - now);
			} catch (err) {
				if (err instanceof TimeoutError) {
					/* eslint no-ex-assign: off */
					throw new DatabaseTimeoutError('打开数据库超时。');
				} else {
					throw new DatabaseError('打开数据库失败。', err);
				}
			}

			return db;
		}
	})();

	/**
	 * @see https://bugs.webkit.org/show_bug.cgi?id=197050
	 * 
	 * > Connection to Indexed Database server lost. Refresh the page to try again
	 */
	/**
	 * 获取 `transaction` 
	 * 
	 * > a transaction will automatically commit when all outstanding requests have been satisfied and no new requests have been made.
	 * 
	 * @see https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction 
	 * 
	 * > The transaction is inactive or finished.
	 * @see {@link https://bugs.webkit.org/show_bug.cgi?id=216769 Safari bug}
	 * 
	 * @param storeNames 
	 * @param mode 
	 */
	export async function beginTransaction(storeNames: string | string[], mode: IDBTransactionMode = 'readonly'): Promise<IDBTransaction> {
		const db = await getSingletonDB();
		return db.transaction(storeNames, mode);
	}

	/**
	 * 获取单个 objectStore
	 * @param storeName 
	 * @param mode 
	 */
	/* eslint @typescript-eslint/no-unused-vars: off */
	export async function getStore(storeName: string, mode: IDBTransactionMode = 'readonly'): Promise<IDBObjectStore> {
		const tx = await beginTransaction(storeName, mode);
		return tx.objectStore(storeName);
	}

	// ---------
	export async function setImageMap(imageMaps: ImageMap | ImageMap[]) {
		const tx = await beginTransaction(IDB_STORENAMES.IMAGE_MAP, 'readwrite');
		const store = tx.objectStore(IDB_STORENAMES.IMAGE_MAP);

		if (!Array.isArray(imageMaps)) imageMaps = [imageMaps];

		for (let imageMap of imageMaps) {
			const [_imageMap] = await getImageMaps({ row: imageMap.row, col: imageMap.col }, { transaction: tx });
			if (_imageMap && _imageMap.id) {
				store.delete(_imageMap.id)
			}

			store.add(imageMap)
		}

		await transaction2promise(tx);
	}

	export async function setImageMap2(imageMaps: ImageMap | ImageMap[]) {
		if (!Array.isArray(imageMaps)) imageMaps = [imageMaps];

		const tx = await beginTransaction(IDB_STORENAMES.IMAGE_MAP, 'readwrite');
		const store = tx.objectStore(IDB_STORENAMES.IMAGE_MAP);
		for (let imageMap of imageMaps) {
			const [_imageMap] = await getImageMaps({ row: imageMap.row, col: imageMap.col }, { transaction: tx });
			if (_imageMap) {
				store.put({
					...imageMap,
					id: _imageMap.id
				})
			} else {
				store.add(imageMap)
			}
		}

		await transaction2promise(tx);
	}

	export async function setImageMap3(imageMaps: ImageMap | ImageMap[]) {
		if (!Array.isArray(imageMaps)) imageMaps = [imageMaps];

		const tx = await beginTransaction(IDB_STORENAMES.IMAGE_MAP, 'readwrite');
		const store = tx.objectStore(IDB_STORENAMES.IMAGE_MAP);

		const tasks = imageMaps.map((imageMap) => {
			return getImageMaps({ row: imageMap.row, col: imageMap.col }, { transaction: tx })
				.then(([_imageMap]) => {
					let request: IDBRequest;
					if (_imageMap && _imageMap.id) {
						request = store.put({
							...imageMap,
							id: _imageMap.id
						})
					} else {
						request = store.add(imageMap)
					}

					return request;
				})
		})
		// for (let imageMap of imageMaps) {
		// 	const [_imageMap] = await getImageMaps({ row: imageMap.row, col: imageMap.col }, { transaction: tx });
		// 	if (_imageMap) {
		// 		store.put({
		// 			...imageMap,
		// 			id: _imageMap.id
		// 		})
		// 	} else {
		// 		store.add(imageMap)
		// 	}
		// }

		// await transaction2promise(tx);
		tasks.push(transaction2promise(tx) as Promise<any>);
		debug(tasks.length)
		await Promise.all(tasks)
	}

	export async function getImageMaps(query: QueryParam, options: QueryOptions = {}) {
		const tx = options.transaction || await beginTransaction(IDB_STORENAMES.IMAGE_MAP);
		const store = tx.objectStore(IDB_STORENAMES.IMAGE_MAP);

		let queryIndex: IDBIndex, queryConditions: IDBKeyRange;
		if (!isNil(query.row) && !isNil(query.col)) {
			queryIndex = store.index('idx_row_col');
			queryConditions = IDBKeyRange.only([query.row, query.col]);
		} else {
			throw new DatabaseIndexError();
		}

		const queryRequest = queryIndex.getAll(queryConditions);
		return request2promise<ImageMap[]>(queryRequest);
	}


	// ---------
	(async () => {
		let imageMaps: ImageMap[] = [];
		for (let row = 0; row < 100; row++) {
			for (let col = 0; col < 100; col++) {
				imageMaps.push({
					row,
					col,
					data: new ArrayBuffer(100)
				})
			}
		}

		const now = Date.now();
		await setImageMap(imageMaps);
		debug('time', Date.now() - now);

		// const now = Date.now();
		// await setImageMap(imageMaps);
		// debug('time', Date.now() - now);

	})().catch(console.error);

	// (async () => {
	// 	const [oldVal] = await getImageMaps({ row: 0, col: 0 });
	// 	const newData = new Uint8Array(100);
	// 	newData.fill(255);
	// 	if (oldVal) {
	// 		const store = await getStore(IDB_STORENAMES.IMAGE_MAP, 'readwrite');
	// 		const request = store.put({
	// 			id: (oldVal as any).id,
	// 			col: 0, 
	// 			row: 0,
	// 			data: newData
	// 		})

	// 		await request2promise(request)
	// 	}
	// })().catch(console.error);
}