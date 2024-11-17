// Main module for OpenDream extension.
'use strict';

import * as net from 'net';
import * as fs from 'fs';
import { CancellationToken, commands, DebugProtocolMessage, ExtensionContext, FileType, ProcessExecution, Task, TaskGroup, TaskProvider, workspace } from 'vscode';
import * as vscode from 'vscode';
import fetch from 'node-fetch';
import * as os from 'os';
import { Octokit } from "@octokit/rest";
import * as zlib from 'zlib';
import * as tar from 'tar';
import * as unzip from 'unzipper';
import { spawn } from 'child_process';

const TaskNames = {
	SOURCE: 'OpenDream',
	BUILD_COMPILER: 'build compiler',
	BUILD_CLIENT: 'build client',
	BUILD_SERVER: 'build server',
	RUN_COMPILER: (dme: string) => `compile ${dme}`,
	RUN_COMPILER_CURRENT: 'compile ${command:CurrentDME}',
	RUN_CLIENT: 'client',
	RUN_SERVER: 'server',
};

let clientTask: vscode.TaskExecution | undefined;

//tag file to keep track of downloaded version
const ODBinVersionTagFile = "latestODBuild.txt"
const LauncherBinVersionTagFile = "latestLauncherBuild.txt"

let storagePath: string | undefined;

let hotReloadCommandFunction: (() => void);

/*
Correctness notes:
	- Tasks passed to `executeTask` must have unique `type` values in their definitions, or VSC will confuse them.
	- `executeTask` is preferred over `createTerminal` for persistence niceties, like the output remaining readable on crash.
*/

// ----------------------------------------------------------------------------
// Entry point.
export async function activate(context: ExtensionContext) {
	// ------------------------------------------------------------------------
	// Register commands.

	// Hidden command used in implementing `launch.json`.
	context.subscriptions.push(commands.registerCommand('opendream.getFilenameJson', async () => {
		return (await commands.executeCommand<string>('dreammaker.getFilenameDme'))?.replace(/\.dme$/, ".json");
	}));

	// ------------------------------------------------------------------------
	// Register the task provider for OpenDream build tasks.
	context.subscriptions.push(vscode.tasks.registerTaskProvider('opendream', new OpenDreamTaskProvider()));

	// ------------------------------------------------------------------------7
	// Register the hot reload command as a handle on the function which is set by the debug adapter
	commands.registerCommand('opendream.hotReload', () => hotReloadCommandFunction())	

	// ------------------------------------------------------------------------
	// Register the debugger mode.

	// I don't really know why this is necessary. The debug configuration this
	// provider returns is the same as the one in "initialConfigurations" in
	// package.json, but apparently VSC uses that only when creating a new
	// launch.json and not when handling an F5 press when a launch.json does
	// not exist.
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('opendream', {
		async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, debugConfiguration: vscode.DebugConfiguration, token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | undefined> {
			// Called with debugConfiguration = {} if launch.json does not exist.
			if (debugConfiguration.type) {
				return debugConfiguration;
			}
			return {
				"type": "opendream",
				"request": "launch",
				"name": `OD: ${await commands.executeCommand<string>('dreammaker.getFilenameDme')}`,
				"preLaunchTask": `${TaskNames.SOURCE}: ${TaskNames.RUN_COMPILER_CURRENT}`,
				"json_path": "${workspaceFolder}/${command:CurrentJson}",
				"noDebug": debugConfiguration.noDebug || false,
			};
		}
	}));

	// register debugger factory to point at OpenDream's debugger mode
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('opendream', {
		async createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): Promise<vscode.DebugAdapterDescriptor | null> {
			let openDream = await getOpenDreamInstallation();
			if (!openDream) {
				return null;
			}
			console.log('---------- Starting OpenDream debug session ----------');

			// Start a server and listen on an arbitrary port.
			const socketPromise = new Promise<net.Socket>((resolve) => {
				const server = net.createServer((socket) => {
					server.close();
					resolve(socket);
				});

				server.listen(0, () => {
					openDream.startServer({
						workspaceFolder: session.workspaceFolder,
						debugPort: (server.address() as net.AddressInfo).port,
						json_path: session.configuration.json_path,
					});
				});
			});

			let buildClientPromise = openDream.buildClient(session.workspaceFolder);
			// Wait for the OD server to connect back to us, then stop listening.
			let socket = await socketPromise;
			let hotReloadEnable:boolean = workspace.getConfiguration('opendream').get('hotReload') || false;
			return new vscode.DebugAdapterInlineImplementation(new OpenDreamDebugAdapter(socket, buildClientPromise, hotReloadEnable));
		}
	}));

	storagePath = context.globalStorageUri?.fsPath
}

// ----------------------------------------------------------------------------
// Task provider

// An alternative approach to using `dotnet run` everywhere would be to use
// tasks running `dotnet build` and `dependsOn` for interdependencies, but
// it's not in the API: https://github.com/microsoft/vscode/issues/132767
class OpenDreamTaskProvider implements TaskProvider {
	async provideTasks(token?: CancellationToken): Promise<Task[]> {
		let openDream = await getOpenDreamInstallation();
		if (!openDream) {
			return [];
		}
		let list = [];

		// Add build tasks for each .dme in the workspace.
		for (let folder of (workspace.workspaceFolders || [])) {
			for (let [file, type] of await workspace.fs.readDirectory(folder.uri)) {
				if (type == FileType.Directory || !file.endsWith('.dme')) {
					continue;
				}

				let task = new Task(
					{ type: "opendream", },
					folder,
					TaskNames.RUN_COMPILER(file),
					TaskNames.SOURCE,
					openDream.getCompilerExecution(folder.uri, file),
					'$openDreamCompiler'
				);
				task.group = TaskGroup.Build;
				list.push(task);
			}
		};
		return list;
	}

	resolveTask(task: Task, token?: CancellationToken): undefined {
		return;
	}
}

// ----------------------------------------------------------------------------
// Debug adapter

class OpenDreamDebugAdapter implements vscode.DebugAdapter {
	private buildClientPromise?: Promise<ODClient>;

	private socket: net.Socket;
	private buffer = Buffer.alloc(0);
	private resourceWatcher?: vscode.FileSystemWatcher
	private interfaceWatcher?: vscode.FileSystemWatcher
	private codeWatcher?: vscode.FileSystemWatcher

	private didSendMessageEmitter = new vscode.EventEmitter<DebugProtocolMessage>();
	private sendMessageToEditor = this.didSendMessageEmitter.fire.bind(this.didSendMessageEmitter);
	onDidSendMessage = this.didSendMessageEmitter.event;

	constructor(socket: net.Socket, buildClientPromise?: Promise<ODClient>, hotReloadAuto?: boolean) {
		this.socket = socket;
		this.buildClientPromise = buildClientPromise;

		// Handle any error condition by terminating debugging, to avoid the
		// session hanging around when it isn't attached to anything. Sending
		// "terminated" multiple times seems to be fine.
		socket.on('error', error => {
			console.error('OpenDreamDebugAdapter:', error);
			this.sendMessageToEditor({ type: "event", event: "terminated" });
		});
		socket.on('close', () => {
			console.log('OpenDreamDebugAdapter closed');
			this.sendMessageToEditor({ type: "event", event: "terminated" });
		});
		socket.on('end', () => {
			console.log('OpenDreamDebugAdapter ended');
			this.sendMessageToEditor({ type: "event", event: "terminated" });
		});

		// Handle received data.
		socket.on('data', received => {
			// Append received data to buffer.
			let old = this.buffer;
			this.buffer = Buffer.alloc(old.length + received.length);
			old.copy(this.buffer);
			received.copy(this.buffer, old.length);

			// Attempt to chop off a complete message.
			let headerEnd = this.buffer.indexOf('\r\n\r\n');
			while (headerEnd >= 0) {
				let headers = this.buffer.toString('utf-8', 0, headerEnd);
				let contentLength = Number(/Content-length: (\d+)/i.exec(headers)![1]);
				let dataEnd = headerEnd + 4 + contentLength;
				if (dataEnd > this.buffer.length) {
					break;
				}

				try {
					let message = JSON.parse(this.buffer.toString('utf-8', headerEnd + 4, dataEnd));
					this.handleMessageFromGame(message);
				} catch (e) {
					console.error(e);
				}

				this.buffer = Buffer.from(this.buffer.buffer.slice(this.buffer.byteOffset + dataEnd));
				headerEnd = this.buffer.indexOf('\r\n\r\n');
			}
		});

		hotReloadCommandFunction = () => this.hotReloadCode()

		if(hotReloadAuto) {
			this.resourceWatcher = vscode.workspace.createFileSystemWatcher(("**/*.{dmi,png,jpg,rsi,gif,bmp}"))//TODO all the sound file formats?
			this.interfaceWatcher = vscode.workspace.createFileSystemWatcher(("**/*.{dmf}"))
			this.codeWatcher = vscode.workspace.createFileSystemWatcher(("**/*.{dm}"))

			this.interfaceWatcher.onDidChange(() => {this.hotReloadInterface()})
			this.interfaceWatcher.onDidCreate(() => {this.hotReloadInterface()})
			this.interfaceWatcher.onDidDelete(() => {this.hotReloadInterface()})
			
			this.resourceWatcher.onDidChange((file) => {this.hotReloadResource(file)})
			this.resourceWatcher.onDidCreate((file) => {this.hotReloadResource(file)})
			this.resourceWatcher.onDidDelete((file) => {this.hotReloadResource(file)})

			this.codeWatcher.onDidChange(() => {this.hotReloadCode()})
			this.codeWatcher.onDidCreate(() => {this.hotReloadCode()})
			this.codeWatcher.onDidDelete(() => {this.hotReloadCode()})
		}
	}

	private hotReloadInterface(): void {
		console.log("Hot reloading interface")
		this.sendMessageToGame({ type: 'request', command: 'hotreloadinterface'})
	}

	private hotReloadResource(resource:vscode.Uri) {
		console.log(`Hot reloading resource ${resource.fsPath}`)
		this.sendMessageToGame({ type: 'request', command: 'hotreloadresource', arguments: {'file':resource.fsPath}})
	}

	private hotReloadCode(): void {
		console.log("Hot reloading code")
		vscode.tasks.fetchTasks({type: 'opendream'}).then((tasks) => {
			for(let x of tasks)
				if(x.name.includes("compile") && x.name.includes(".dme")) 
					return vscode.tasks.executeTask(x);	
			throw Error("Can't find compile task!")		
		}).then((execution)=>{
			vscode.tasks.onDidEndTask((event) => {
				if(event.execution.task == execution.task)
					console.log("compile complete, sending hot reload request")				
					commands.executeCommand('opendream.getFilenameJson').then(
						(filename)=>this.sendMessageToGame({ type: 'request', command: 'hotreloadbytecode', arguments: {'file':filename}})
					)					
			})
		})
	}

	handleMessage(message: any): void {
		if (message.type == 'request' && message.command == 'disconnect') {
			// Kill the client when the Stop button is clicked.
			// This has the unfortunate side-effect of removing its terminal entirely.
			clientTask?.terminate();
			clientTask = undefined;
		}
		this.sendMessageToGame(message);
	}

	private sendMessageToGame(message: DebugProtocolMessage): void {
		let json = JSON.stringify(message);
		this.socket.write(`Content-Length: ${json.length}\r\n\r\n${json}`);
	}

	private async handleMessageFromGame(message: any): Promise<void> {
		if (message.type == 'event' && message.event == '$opendream/ready') {
			// Launch the OD client.
			let gamePort = message.body.gamePort;
			this.buildClientPromise?.then(async client => {
				clientTask = await client.start(gamePort);
			});
		}
		this.sendMessageToEditor(message);
	}

	dispose() {
		this.resourceWatcher?.dispose()
		this.interfaceWatcher?.dispose()
		this.codeWatcher?.dispose()
		
		this.socket.destroy();
		this.didSendMessageEmitter.dispose();
	}
}

// ----------------------------------------------------------------------------
// Abstraction over possible OpenDream installation methods.

interface OpenDreamInstallation {
	getCompilerExecution(workspaceFolder:  vscode.Uri, dme: string): ProcessExecution | vscode.ShellExecution | vscode.CustomExecution;
	buildClient(workspaceFolder?: vscode.WorkspaceFolder): Promise<ODClient>;
	startServer(params: { workspaceFolder?: vscode.WorkspaceFolder, debugPort: number, json_path: string }): Promise<void>;
}

interface ODClient {
	start(gamePort: number): Promise<vscode.TaskExecution>;
}

async function getOpenDreamInstallation(): Promise<OpenDreamInstallation | undefined> {
	// Check if the path is an OpenDream source checkout.
	function isOpenDreamSource(path: string): Promise<boolean> {
		return new Promise((resolve, reject) => {
			try {
				const exists = fs.existsSync(`${path}/OpenDream.sln`);
				resolve(exists);
			} catch (error) {
				reject(error);
			}
		});
	}



	// Check if one of the workspace folders is an OpenDream source checkout.
	for (let folder of workspace.workspaceFolders || []) {
		if (folder.uri.scheme === 'file' && await isOpenDreamSource(folder.uri.fsPath)) {
			return new ODWorkspaceFolderInstallation(folder);
		}
	}

	// Check if the configured path is a valid OpenDream source checkout.
	let configuredPath: string | undefined = workspace.getConfiguration('opendream').get('sourcePath');
	if (configuredPath && await isOpenDreamSource(configuredPath)) {
		console.log("Using source installation")
		return new ODSourceInstallation(configuredPath);
	} else {
		console.log("Using binary installation")
		return new ODBinaryDistribution(storagePath!);
	}
}

class ODBinaryDistribution implements OpenDreamInstallation {
	protected path: string;

	constructor(path: string) {
		this.path = path;
	}

	getCompilerExecution(workspaceFolder:  vscode.Uri, dme: string): vscode.CustomExecution {
		return new vscode.CustomExecution(
			async (resolvedDefinition): Promise<vscode.Pseudoterminal> => {
				await this.updateOpenDreamBinary(this.path);
				const writeEmitter = new vscode.EventEmitter<string>();
				const closeEmitter = new vscode.EventEmitter<number>();
				const pty: vscode.Pseudoterminal = {
					onDidWrite: writeEmitter.event,
					onDidClose: closeEmitter.event,
					open: () => { },
					close: () => { }
				};

				const compilerPath = `${this.path}/DMCompiler_${getArchSuffix()}/DMCompiler${os.platform() === "win32" ? ".exe" : ""}`;
				let compileProcess = spawn(compilerPath, [dme], { cwd: workspaceFolder.fsPath });

				compileProcess.on('close', (code) => {
					console.log(`Compiler process exited with code ${code}`);
					closeEmitter.fire(code === null ? 1 : code);
				}); 

				compileProcess.on('error', (err) => {
					writeEmitter.fire(`Error running compiler process: ${err.message}\r\n`);
					closeEmitter.fire(1);
				})
				
				compileProcess.stdout.on('data', (data) => {
					writeEmitter.fire(data.toString().replaceAll('\n', "\r\n"));
				});
				
				compileProcess.stderr.on('data', (data) => {
					writeEmitter.fire(data.toString().replaceAll('\n', "\r\n"));
				});
				
				return pty;
			});
	}

	async buildClient(workspaceFolder?: vscode.WorkspaceFolder): Promise<ODClient> {
		return {
			start: async (gamePort) => {
				//hack to make the launcher executable because zip files don't have permissions preserved on extraction
				fs.chmodSync(`${this.path}/SS14.Launcher/bin/SS14.Launcher${os.platform() === "win32" ? ".exe" : ""}`, 0o777)
				fs.chmodSync(`${this.path}/SS14.Launcher/bin/loader/SS14.Loader${os.platform() === "win32" ? ".exe" : ""}`, 0o777)
				return await startDedicatedTask(new Task(
					{ type: 'opendream_debug_client' },
					workspaceFolder || vscode.TaskScope.Workspace,
					TaskNames.RUN_CLIENT,
					TaskNames.SOURCE,
					new ProcessExecution(`${this.path}/SS14.Launcher/bin/SS14.Launcher${os.platform() === "win32" ? ".exe" : ""}`, [
						`ss14://127.0.0.1:${gamePort}`,
					]),
				));
			}
		}
	}

	async startServer(params: { workspaceFolder?: vscode.WorkspaceFolder, debugPort: number, json_path: string }): Promise<void> {
		await startDedicatedTask(new Task(
			{ type: 'opendream_debug_server' },
			params.workspaceFolder || vscode.TaskScope.Workspace,
			TaskNames.RUN_SERVER,
			TaskNames.SOURCE,
			new ProcessExecution(`${this.path}/OpenDreamServer_${getArchSuffix()}/Robust.Server${os.platform() === "win32" ? ".exe" : ""}`, [
				"--cvar", `server.port=0`,
				"--cvar", `opendream.debug_adapter_launched=${params.debugPort}`,
				"--cvar", `opendream.json_path=${params.json_path}`,
			]),
		));
	}

	// Checks if the OpenDream binaries exist and are up-to-date, and downloads them if not
	async updateOpenDreamBinary(path: string): Promise<void> {
		if (!fs.existsSync(path))
			fs.mkdirSync(path);

		const octokit = new Octokit();
		//get SS14 launcher release
		let launcherResponse = await octokit.rest.repos.getLatestRelease({
			owner: 'space-wizards',
			repo: 'SS14.Launcher',
		})

		if (launcherResponse.status != 200) {
			vscode.window.showErrorMessage(`Failed to fetch SS14.Launcher releases: HTTP error code ${launcherResponse.status}`);
			return;
		}
		const launcherData = launcherResponse.data
		let launcherURL

		launcherData.assets.forEach((asset) => {
			if (asset.name.includes(getArchSuffixForLauncher())) {
				launcherURL = asset.browser_download_url
			}
		})
		if (launcherURL == undefined) {
			vscode.window.showErrorMessage(`Failed to find a suitable SS14.Launcher binary for your platform (${getArchSuffixForLauncher()}`)
			return
		}


		//check tag against local tag
		let doUpdateLauncher = true;
		if (fs.existsSync(path + "/" + LauncherBinVersionTagFile)) {
			let txt = fs.readFileSync(path + "/" + LauncherBinVersionTagFile, 'utf8')
			if (txt == launcherData.tag_name) {
				console.log("Launcher binary is up to date")
				doUpdateLauncher = false;
			} else {
				console.log("Launcher binary is out of date")
				doUpdateLauncher = true;
			}
		}

		//get opendream release
		let response = await octokit.rest.repos.getReleaseByTag({
			owner: 'OpenDreamProject',
			repo: 'OpenDream',
			tag: 'latest'
		})

		if (response.status != 200) {
			vscode.window.showErrorMessage(`Failed to fetch OpenDream releases: HTTP error code ${response.status}`);
			return;
		}

		const data = response.data
		let doUpdateOD = true;
		//check published_at against local file date
		if (fs.existsSync(path + "/" + ODBinVersionTagFile)) {
			let txt = fs.readFileSync(path + "/" + ODBinVersionTagFile, 'utf8')
			if (txt == data.published_at) {
				console.log("OpenDream binary is up to date")
				doUpdateOD = false;
			} else {
				console.log("OpenDream binary is out of date")
				doUpdateOD = true;
			}
		}

		let returnPromiseList = [];

		if (doUpdateOD) {
			console.log("Updating OpenDream binaries");
			vscode.window.showInformationMessage("OpenDream binaries are out of date, updating...")
			var compilerURL
			var serverURL
			data.assets.forEach((asset) => {
				if (asset.name.includes(getArchSuffix())) {
					if (asset.name.includes("DMCompiler"))
						compilerURL = asset.browser_download_url
					else if (asset.name.includes("OpenDreamServer_TOOLS"))
						serverURL = asset.browser_download_url
				}
			})
			if (compilerURL == undefined || serverURL == undefined) {
				vscode.window.showErrorMessage(`Failed to find a suitable OpenDream binary for your platform (${getArchSuffix()})`)
				return
			}

			let compilerGetAndExtract = fetchAndExtract(compilerURL, path)
			let serverGetANdExtract = fetchAndExtract(serverURL, path)


			//create tag file for update checking
			returnPromiseList.push(Promise.all([compilerGetAndExtract, serverGetANdExtract]).then(() => {
				fs.writeFileSync(path + "/" + ODBinVersionTagFile, data.published_at!)
			}));
		}

		if (doUpdateLauncher) {
			console.log("Updating SS14 Launcher");
			vscode.window.showInformationMessage("SS14 Launcher binaries are out of date, updating...")
			let launcherGetAndExtract = fetchAndExtract(launcherURL, path + "/SS14.Launcher/")
				.then(() => { fs.writeFileSync(path + "/" + LauncherBinVersionTagFile, launcherData.tag_name!) })

			returnPromiseList.push(launcherGetAndExtract)
		}

		return Promise.all(returnPromiseList).then(() => {
			console.log("updateOpenDreamBinary completed")
			if (doUpdateOD || doUpdateLauncher)
				vscode.window.showInformationMessage("OpenDream binaries updated successfully!")
		});
	}
}

// OpenDream source code, to be built & run.
class ODSourceInstallation implements OpenDreamInstallation {
	protected path: string;

	constructor(path: string) {
		this.path = path;
	}

	getCompilerExecution(workspaceFolder:  vscode.Uri, dme: string): ProcessExecution {
		return new ProcessExecution("dotnet", [
			"run",
			"--project", `${this.path}/DMCompiler`,
			"--",
			dme,
		]);
	}

	async buildClient(workspaceFolder?: vscode.WorkspaceFolder): Promise<ODClient> {
		await waitForTaskToEnd(await startDedicatedTask(new Task(
			{ type: 'opendream_debug_client' },
			workspaceFolder || vscode.TaskScope.Workspace,
			TaskNames.BUILD_CLIENT,
			TaskNames.SOURCE,
			new ProcessExecution("dotnet", [
				"build",
				"-c", "Tools",
				`${this.path}/OpenDreamClient`,
			]),
		)));
		return {
			start: async (gamePort) => {
				return await startDedicatedTask(new Task(
					{ type: 'opendream_debug_client' },
					vscode.TaskScope.Workspace,
					TaskNames.RUN_CLIENT,
					TaskNames.SOURCE,
					new ProcessExecution("dotnet", [
						"run",
						"--no-build",  // because we built above
						"--project", `${this.path}/OpenDreamClient`,
						"--",
						"--connect",
						"--connect-address", `127.0.0.1:${gamePort}`,
					]),
				));
			}
		};
	}

	async startServer(params: { workspaceFolder?: vscode.WorkspaceFolder, debugPort: number, json_path: string }): Promise<void> {
		// Use executeTask instead of createTerminal so it will be readable if it crashes.
		await startDedicatedTask(new Task(
			{ type: 'opendream_debug_server' },
			params.workspaceFolder || vscode.TaskScope.Workspace,
			TaskNames.RUN_SERVER,
			TaskNames.SOURCE,
			new ProcessExecution("dotnet", [
				"run",
				"--project", `${this.path}/OpenDreamServer`,
				"-c", "Tools",
				"--",
				"--cvar", `server.port=0`,
				"--cvar", `opendream.debug_adapter_launched=${params.debugPort}`,
				"--cvar", `opendream.json_path=${params.json_path}`,
			]),
		));
	}
}

// OpenDream source code, also open in VSC. Can be debugged.
class ODWorkspaceFolderInstallation extends ODSourceInstallation {
	private workspaceFolder: vscode.WorkspaceFolder;

	constructor(workspaceFolder: vscode.WorkspaceFolder) {
		super(workspaceFolder.uri.fsPath);
		this.workspaceFolder = workspaceFolder;
	}

	async startServer(params: { workspaceFolder?: vscode.WorkspaceFolder | undefined; debugPort: number; json_path: string; }): Promise<void> {
		// Build, then run.
		await waitForTaskToEnd(await vscode.tasks.executeTask(new Task(
			{ type: 'opendream_debug_server' },
			this.workspaceFolder || vscode.TaskScope.Workspace,
			TaskNames.BUILD_SERVER,
			TaskNames.SOURCE,
			new ProcessExecution("dotnet", [
				"build",
				"-c", "Tools",
				`${this.path}/OpenDreamServer`,
			]),
		)));

		await vscode.debug.startDebugging(
			this.workspaceFolder,
			{
				name: "C#: OpenDream server",
				type: "coreclr",
				request: "launch",
				// No preLaunchTask since we do it manually above.
				program: "${workspaceFolder}/bin/Content.Server/OpenDreamServer",
				args: [
					"--cvar", `server.port=0`,
					"--cvar", `opendream.debug_adapter_launched=${params.debugPort}`,
					"--cvar", `opendream.json_path=${params.json_path}`,
				],
			}
		);
	}
}

function waitForTaskToEnd(task: vscode.TaskExecution): Promise<void> {
	return new Promise<void>(resolve => {
		let registration = vscode.tasks.onDidEndTask(event => {
			if (event.execution == task) {
				resolve();
				registration.dispose();
			}
		});
	});
}

function startDedicatedTask(task: vscode.Task): Thenable<vscode.TaskExecution> {
	task.presentationOptions.panel = vscode.TaskPanelKind.Dedicated;
	task.presentationOptions.showReuseMessage = false;
	return vscode.tasks.executeTask(task);
}

// Function to extract a .tar.gz file for unpacking bins from github
// thanks chatgpt <3
function extractTarGz(tarGzPath: string, outputDir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// Create a read stream for the .tar.gz file
		const readStream = fs.createReadStream(tarGzPath);
		// Create a gunzip stream to decompress the .gz file
		const gunzipStream = zlib.createGunzip();
		// Create a tar extract stream to extract the tar contents
		const extractStream = tar.extract({ cwd: outputDir });

		// Pipe the streams together: read -> gunzip -> extract
		readStream
			.pipe(gunzipStream)
			.pipe(extractStream)
			.on('finish', resolve)
			.on('error', reject);
	});
}

function fetchAndExtract(url: string, outputDir: string) {
	let tmpfilename = url.split('/').pop()?.split('?')[0] || '';

	return fetch(url).then((response) => {
		return new Promise((resolve, reject) => {
			const dest = fs.createWriteStream(`${storagePath}/${tmpfilename}`);
			response.body?.pipe(dest);
			dest.on('finish', () => {
				dest.close();
				console.log(`Downloaded ${tmpfilename} to ${storagePath}/${tmpfilename}`);
				if (tmpfilename.endsWith('.tar.gz'))
					return extractTarGz(`${storagePath}/${tmpfilename}`, outputDir)
						.then(() => {
							console.log(`Extracted ${storagePath}/${tmpfilename} to ${outputDir}`)
							resolve(null)
						})
						.catch((e) => {
							vscode.window.showErrorMessage(`Unable to extract ${tmpfilename} downloaded from github! Error: ${e}`)
							reject(e);
						});
				else if (tmpfilename.endsWith('.zip'))
					return extractZip(`${storagePath}/${tmpfilename}`, outputDir)
						.then(() => {
							console.log(`Extracted ${storagePath}/${tmpfilename} to ${outputDir}`)
							resolve(null)
						})
						.catch((e) => {
							vscode.window.showErrorMessage(`Unable to extract ${tmpfilename} downloaded from github! Error: ${e}`)
							reject(e);
						});
			}).on('error', reject);
		});
	})
}

function extractZip(zipPath: string, outputDir: string): Promise<void> {
	if (!fs.existsSync(zipPath)) {
		throw new Error(`File not found: ${zipPath}`);
	}
	return unzip.Open.file(zipPath).then(d => d.extract({ path: outputDir, concurrency: 5 }));
}

function getArchSuffix(): string {
	let arch: string = os.arch()
	let platform: string = os.platform()
	if (platform === "win32")
		platform = "win"
	return `${platform}-${arch}`
}

function getArchSuffixForLauncher(): string {
	let platform: string = os.platform()
	if (platform === "win32")
		platform = "Windows"
	if (platform === "darwin")
		platform = "macOS"
	if (platform === "linux")
		platform = "Linux"
	return platform
}