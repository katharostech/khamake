import * as child_process from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import {sys} from './exec';
import * as korepath from './korepath';
import * as log from './log';
import {Options} from './Options';
import {Platform} from './Platform';
import {Project, Target, Library} from './Project';
import {loadProject, Callbacks} from './ProjectFile';
import {VisualStudioVersion} from './VisualStudioVersion';
import {AssetConverter} from './AssetConverter';
import {HaxeCompiler} from './HaxeCompiler';
import {ShaderCompiler, CompiledShader} from './ShaderCompiler';
import {KhaExporter} from './Exporters/KhaExporter';
import {AndroidExporter} from './Exporters/AndroidExporter';
import {DebugHtml5Exporter} from './Exporters/DebugHtml5Exporter';
import {EmptyExporter} from './Exporters/EmptyExporter';
import {FlashExporter} from './Exporters/FlashExporter';
import {Html5Exporter} from './Exporters/Html5Exporter';
import {Html5WorkerExporter} from './Exporters/Html5WorkerExporter';
import {JavaExporter} from './Exporters/JavaExporter';
import {KoreExporter} from './Exporters/KoreExporter';
import {KoreHLExporter} from './Exporters/KoreHLExporter';
import {KromExporter} from './Exporters/KromExporter';
import {NodeExporter} from './Exporters/NodeExporter';
import {PlayStationMobileExporter} from './Exporters/PlayStationMobileExporter';
import {WpfExporter} from './Exporters/WpfExporter';
import {UnityExporter} from './Exporters/UnityExporter';
import {writeHaxeProject} from './HaxeProject';

let lastAssetConverter: AssetConverter;
let lastShaderCompiler: ShaderCompiler;
let lastHaxeCompiler: HaxeCompiler;

function fixName(name: string): string {
	name = name.replace(/[-@\ \.\/\\]/g, '_');
	if (name[0] === '0' || name[0] === '1' || name[0] === '2' || name[0] === '3' || name[0] === '4'
		|| name[0] === '5' || name[0] === '6' || name[0] === '7' || name[0] === '8' || name[0] === '9') {
		name = '_' + name;
	}
	return name;
}

function safeName(name: string): string {
	return name.replace(/[\\\/]/g, '_');
}

function createKorefile(name: string, exporter: KhaExporter, options: any, targetOptions: any, libraries: Library[], cdefines: string[], stackSize: number, korehl: boolean): string {
	let out = '';
	out += 'let fs = require(\'fs\');\n';
	out += 'let path = require(\'path\');\n';
	out += 'let project = new Project(\'' + name + '\');\n';

	for (let cdefine of cdefines) {
		out += 'project.addDefine(\'' + cdefine + '\');\n';
	}

	if (options.haxe3) {
		out += 'project.addDefine(\'HXCPP_API_LEVEL=331\');\n';
	}
	else {
		out += 'project.addDefine(\'HXCPP_API_LEVEL=332\');\n';
	}

	out += 'project.addDefine(\'HXCPP_DEBUG\', \'Debug\');\n';

	if (targetOptions) {
		let koreTargetOptions: any = {};
		for (let option in targetOptions) {
			if (option.endsWith('_native')) continue;
			koreTargetOptions[option] = targetOptions[option];
		}
		for (let option in targetOptions) {
			if (option.endsWith('_native')) {
				koreTargetOptions[option.substr(0, option.length - '_native'.length)] = targetOptions[option];
			}
		}
		out += 'project.targetOptions = ' + JSON.stringify(koreTargetOptions) + ';\n';
	}

	out += 'project.setDebugDir(\'' + path.relative(options.from, path.join(options.to, exporter.sysdir())).replace(/\\/g, '/') + '\');\n';

	let buildpath = path.relative(options.from, path.join(options.to, exporter.sysdir() + '-build')).replace(/\\/g, '/');
	if (buildpath.startsWith('..')) buildpath = path.resolve(path.join(options.from.toString(), buildpath));
	out += 'await project.addProject(\'' + buildpath.replace(/\\/g, '/') + '\');\n';
	if (korehl) out += 'await project.addProject(\'' + path.join(options.kha, 'Backends', 'KoreHL').replace(/\\/g, '/') + '\');\n';
	else out += 'await project.addProject(\'' + path.normalize(options.kha).replace(/\\/g, '/') + '\');\n';

	for (let lib of libraries) {
		let libPath: string = lib.libroot;
		out += 'if (fs.existsSync(path.join(\'' + libPath.replace(/\\/g, '/') + '\', \'korefile.js\'))) {\n';
		if (path.isAbsolute(libPath)) {
			out += '\tawait project.addProject(\'' + libPath.replace(/\\/g, '/') + '\');\n';
		}
		else {
			out += '\tawait project.addProject(path.join(\'..\', \'' + libPath.replace(/\\/g, '/') + '\'));\n';
		}
		out += '}\n';
	}
	if (stackSize) {
		out += 'project.stackSize = ' + stackSize + ';\n';
	}
	out += 'resolve(project);\n';

	return out;
}

async function exportProjectFiles(name: string, resourceDir: string, options: Options, exporter: KhaExporter, kore: boolean, korehl: boolean,
	libraries: Library[], targetOptions: any, defines: string[], cdefines: string[], stackSize: number): Promise<string> {
	if (options.haxe !== '') {
		let haxeOptions = exporter.haxeOptions(name, targetOptions, defines);
		haxeOptions.defines.push('kha');
		haxeOptions.defines.push('kha_version=1810');
		haxeOptions.defines.push('kha_project_name=' + haxeOptions.name);
		haxeOptions.safeName = safeName(haxeOptions.name);

		if (options.debug && haxeOptions.parameters.indexOf('-debug') < 0) {
			haxeOptions.parameters.push('-debug');
		}

		writeHaxeProject(options.to, !options.noproject, haxeOptions);

		if (!options.nohaxe) {
			let compiler = new HaxeCompiler(options.to, haxeOptions.to, haxeOptions.realto, resourceDir, options.haxe, 'project-' + exporter.sysdir() + '.hxml', haxeOptions.sources, exporter.sysdir());
			lastHaxeCompiler = compiler;
			try {
				await compiler.run(options.watch);
			}
			catch (error) {
				return Promise.reject(error);
			}
		}
		for (let callback of Callbacks.postHaxeCompilation) {
			callback();
		}

		await exporter.export(name, targetOptions, haxeOptions);
	}

	let buildDir = path.join(options.to, exporter.sysdir() + '-build');

	if (options.haxe !== '' && kore && !options.noproject) {
		// If target is a Kore project, generate additional project folders here.
		// generate the korefile.js
		fs.copySync(path.join(__dirname, '..', 'Data', 'build-korefile.js'), path.join(buildDir, 'korefile.js'), { overwrite: true });
		fs.writeFileSync(path.join(options.to, 'korefile.js'), createKorefile(name, exporter, options, targetOptions, libraries, cdefines, stackSize, false));

		// Similar to khamake.js -> main.js -> run(...)
		// We now do koremake.js -> main.js -> run(...)
		// This will create additional project folders for the target,
		// e.g. 'build/android-native-build'
		try {
			let name = await require(path.join(korepath.get(), 'out', 'main.js')).run(
			{
				from: options.from,
				to: buildDir,
				korefile: 'build/korefile.js',
				target: koreplatform(options.target),
				graphics: options.graphics,
				audio: options.audio,
				vrApi: options.vr,
				raytrace: options.raytrace,
				visualstudio: options.visualstudio,
				compile: options.compile,
				run: options.run,
				debug: options.debug,
				noshaders: true
			},
			{
				info: log.info,
				error: log.error
			});
			for (let callback of Callbacks.postCppCompilation) {
				callback();
			}
			log.info('Done.');
			return name;
		}
		catch (error) {
			log.error(error);
			return '';
		}
	}
	else if (options.haxe !== '' && korehl && !options.noproject) {
		fs.copySync(path.join(__dirname, '..', 'Data', 'hl', 'kore_sources.c'), path.join(buildDir, 'kore_sources.c'), { overwrite: true });
		fs.copySync(path.join(__dirname, '..', 'Data', 'hl', 'korefile.js'), path.join(buildDir, 'korefile.js'), { overwrite: true });
		fs.writeFileSync(path.join(options.to, 'korefile.js'), createKorefile(name, exporter, options, targetOptions, libraries, cdefines, stackSize, korehl));

		try {
			let name = await require(path.join(korepath.get(), 'out', 'main.js')).run(
			{
				from: options.from,
				to: buildDir,
				korefile: 'build/korefile.js',
				target: koreplatform(options.target),
				graphics: options.graphics,
				vrApi: options.vr,
				raytrace: options.raytrace,
				visualstudio: options.visualstudio,
				compile: options.compile,
				run: options.run,
				debug: options.debug,
				noshaders: true
			},
			{
				info: log.info,
				error: log.error
			});
			log.info('Done.');
			return name;
		}
		catch (error) {
			log.error(error);
			return '';
		}
	}
	else {
		// If target is not a Kore project, e.g. HTML5, finish building here.
		log.info('Done.');
		return name;
	}
}

function checkKorePlatform(platform: string) {
	return platform === 'windows'
		|| platform === 'windowsapp'
		|| platform === 'ios'
		|| platform === 'osx'
		|| platform === 'android'
		|| platform === 'linux'
		|| platform === 'html5'
		|| platform === 'tizen'
		|| platform === 'pi'
		|| platform === 'tvos'
		|| platform === 'ps4'
		|| platform === 'xboxone'
		|| platform === 'switch';
}

function koreplatform(platform: string) {
	// 'android-native' becomes 'android'
	if (platform.endsWith('-native')) return platform.substr(0, platform.length - '-native'.length);
	else if (platform.endsWith('-native-hl')) return platform.substr(0, platform.length - '-native-hl'.length);
	else if (platform.endsWith('-hl')) return platform.substr(0, platform.length - '-hl'.length);
	else return platform;
}

async function exportKhaProject(options: Options): Promise<string> {
	log.info('Creating Kha project.');

	let project: Project = null;
	let foundProjectFile = false;

	// get the khafile.js and load the config code,
	// then create the project config object, which contains stuff
	// like project name, assets paths, sources path, library path...
	if (fs.existsSync(path.join(options.from, options.projectfile))) {
		try {
			project = await loadProject(options.from, options.projectfile, options.target);
		}
		catch (x) {
			log.error(x);
			throw 'Loading the projectfile failed.';
		}

		foundProjectFile = true;
	}

	if (!foundProjectFile) {
		throw 'No khafile found.';
	}

	let temp = path.join(options.to, 'temp');
	fs.ensureDirSync(temp);

	let exporter: KhaExporter = null;
	let kore = false;
	let korehl = false;

	let target = options.target.toLowerCase();
	let baseTarget = target;
	let customTarget: Target = null;
	if (project.customTargets.get(options.target)) {
		customTarget = project.customTargets.get(options.target);
		baseTarget = customTarget.baseTarget;
	}

	switch (baseTarget) {
		case Platform.Krom:
			exporter = new KromExporter(options);
			break;
		case Platform.Flash:
			exporter = new FlashExporter(options);
			break;
		case Platform.HTML5:
			exporter = new Html5Exporter(options);
			break;
		case Platform.HTML5Worker:
			exporter = new Html5WorkerExporter(options);
			break;
		case Platform.DebugHTML5:
			exporter = new DebugHtml5Exporter(options);
			break;
		case Platform.WPF:
			exporter = new WpfExporter(options);
			break;
		case Platform.Java:
			exporter = new JavaExporter(options);
			break;
		case Platform.PlayStationMobile:
			exporter = new PlayStationMobileExporter(options);
			break;
		case Platform.Android:
			// 'android-native' bypasses this option
			exporter = new AndroidExporter(options);
			break;
		case Platform.Node:
			exporter = new NodeExporter(options);
			break;
		case Platform.Unity:
			exporter = new UnityExporter(options);
			break;
		case Platform.Empty:
			exporter = new EmptyExporter(options);
			break;
		default:
			if (target.endsWith('-hl')) {
				korehl = true;
				options.target = koreplatform(target);
				if (!checkKorePlatform(options.target)) {
					log.error('Unknown platform: ' + options.target);
					return Promise.reject('');
				}
				exporter = new KoreHLExporter(options);
			}
			else {
				kore = true;
				// If target is 'android-native' then options.target becomes 'android'
				options.target = koreplatform(target);
				if (!checkKorePlatform(options.target)) {
					log.error('Unknown platform: ' + options.target);
					return Promise.reject('');
				}
				exporter = new KoreExporter(options);
			}
			break;
	}
	exporter.setSystemDirectory(target);
	let buildDir = path.join(options.to, exporter.sysdir() + '-build');

	// Create the target build folder
	// e.g. 'build/android-native'
	fs.ensureDirSync(path.join(options.to, exporter.sysdir()));

	let defaultWindowOptions = {
		width: 800,
		height: 600
	};

	let windowOptions = project.windowOptions ? project.windowOptions : defaultWindowOptions;
	exporter.setName(project.name);
	exporter.setWidthAndHeight(
		'width' in windowOptions ? windowOptions.width : defaultWindowOptions.width,
		'height' in windowOptions ? windowOptions.height : defaultWindowOptions.height
	);

	for (let source of project.sources) {
		exporter.addSourceDirectory(source);
	}
	for (let library of project.libraries) {
		exporter.addLibrary(library);
	}
	exporter.parameters = exporter.parameters.concat(project.parameters);
	project.scriptdir = options.kha;
	if (baseTarget !== Platform.Java && baseTarget !== Platform.WPF) {
		project.addShaders('Sources/Shaders/**', {});
	}

	for (let callback of Callbacks.preAssetConversion) {
		callback();
	}

	let assetConverter = new AssetConverter(exporter, options, project.assetMatchers);
	lastAssetConverter = assetConverter;
	let assets = await assetConverter.run(options.watch, temp);

	let shaderDir = path.join(options.to, exporter.sysdir() + '-resources');
	if (target === Platform.Unity) {
		shaderDir = path.join(options.to, exporter.sysdir(), 'Assets', 'Shaders');
	}

	for (let callback of Callbacks.preShaderCompilation) {
		callback();
	}
	fs.ensureDirSync(shaderDir);

	let oldResources: any = null;
	let recompileAllShaders = false;
	try {
		oldResources = JSON.parse(fs.readFileSync(path.join(options.to, exporter.sysdir() + '-resources', 'files.json'), 'utf8'));
		for (let file of oldResources.files) {
			if (file.type === 'shader') {
				if (!file.files || file.files.length === 0) {
					recompileAllShaders = true;
					break;
				}
			}
		}
	}
	catch (error) {

	}

	let exportedShaders: CompiledShader[] = [];
	if (!options.noshaders) {
		if (fs.existsSync(path.join(options.from, 'Backends'))) {
			let libdirs = fs.readdirSync(path.join(options.from, 'Backends'));
			for (let ld in libdirs) {
				let libdir = path.join(options.from, 'Backends', libdirs[ld]);
				if (fs.statSync(libdir).isDirectory()) {
					let exe = path.join(libdir, 'krafix', 'krafix-' + options.target + '.exe');
					if (fs.existsSync(exe)) {
						options.krafix = exe;
					}
				}
			}
		}

		let shaderCompiler = new ShaderCompiler(exporter, options.target, options.krafix, shaderDir, temp,
		buildDir, options, project.shaderMatchers);
		lastShaderCompiler = shaderCompiler;
		try {
			exportedShaders = await shaderCompiler.run(options.watch, recompileAllShaders);
		}
		catch (err) {
			return Promise.reject(err);
		}
	}

	if (target === Platform.Unity) {
		fs.ensureDirSync(path.join(options.to, exporter.sysdir() + '-resources'));
		for (let shader of exportedShaders) {
			fs.writeFileSync(path.join(options.to, exporter.sysdir() + '-resources', shader.name + '.hlsl'), shader.name);
		}
		let proto = fs.readFileSync(path.join(options.from, options.kha, 'Tools', 'khamake', 'Data', 'unity', 'Shaders', 'proto.shader'), 'utf8');
		for (let i1 = 0; i1 < exportedShaders.length; ++i1) {
			if (exportedShaders[i1].name.endsWith('.vert')) {
				for (let i2 = 0; i2 < exportedShaders.length; ++i2) {
					if (exportedShaders[i2].name.endsWith('.frag')) {
						let shadername = exportedShaders[i1].name + '.' + exportedShaders[i2].name;
						let proto2 = proto.replace(/{name}/g, shadername);
						proto2 = proto2.replace(/{vert}/g, exportedShaders[i1].name);
						proto2 = proto2.replace(/{frag}/g, exportedShaders[i2].name);
						fs.writeFileSync(path.join(shaderDir, shadername + '.shader'), proto2, 'utf8');
					}
				}
			}
		}
		let blobDir = path.join(options.to, exporter.sysdir(), 'Assets', 'Resources', 'Blobs');
		fs.ensureDirSync(blobDir);
		for (let i = 0; i < exportedShaders.length; ++i) {
			fs.writeFileSync(path.join(blobDir, exportedShaders[i].files[0] + '.bytes'), exportedShaders[i].name, 'utf8');
		}
	}

	function findShader(name: string) {
		let fallback: any = { };
		fallback.files = [];
		fallback.inputs = [];
		fallback.outputs = [];
		fallback.uniforms = [];
		fallback.types = [];

		try {
			for (let file of oldResources.files) {
				if (file.type === 'shader' && file.name === fixName(name)) {
					return file;
				}
			}
		}
		catch (error) {
			return fallback;
		}
		return fallback;
	}

	let files: {name: string, files: string[], type: string, inputs: any[], outputs: any[], uniforms: any[], types: any[]}[] = [];
	for (let asset of assets) {
		let file: any = {
			name: fixName(asset.name),
			files: asset.files,
			type: asset.type
		};
		if (file.type === 'image') {
			file.original_width = asset.original_width;
			file.original_height = asset.original_height;
			if (asset.readable) file.readable = asset.readable;
		}
		files.push(file);
	}
	for (let shader of exportedShaders) {
		let oldShader = findShader(shader.name);
		files.push({
			name: fixName(shader.name),
			files: shader.files === null ? oldShader.files : shader.files,
			type: 'shader',
			inputs: shader.inputs === null ? oldShader.inputs : shader.inputs,
			outputs: shader.outputs === null ? oldShader.outputs : shader.outputs,
			uniforms: shader.uniforms === null ? oldShader.uniforms : shader.uniforms,
			types: shader.types === null ? oldShader.types : shader.types
		});
	}

	function secondPass() {
		// First pass is for main project files. Second pass is for shaders.
		// Will try to look for the folder, e.g. 'build/Shaders'.
		// if it exists, export files similar to other a
		let hxslDir = path.join('build', 'Shaders');
		/** if (fs.existsSync(hxslDir) && fs.readdirSync(hxslDir).length > 0) {
			addShaders(exporter, platform, project, from, to.resolve(exporter.sysdir() + '-resources'), temp, from.resolve(Paths.get(hxslDir)), krafix);
			if (foundProjectFile) {
				fs.outputFileSync(to.resolve(Paths.get(exporter.sysdir() + '-resources', 'files.json')).toString(), JSON.stringify({ files: files }, null, '\t'), { encoding: 'utf8' });
				log.info('Assets done.');
				exportProjectFiles(name, from, to, options, exporter, platform, khaDirectory, haxeDirectory, kore, project.libraries, project.targetOptions, callback);
			}
			else {
				exportProjectFiles(name, from, to, options, exporter, platform, khaDirectory, haxeDirectory, kore, project.libraries, project.targetOptions, callback);
			}
		}*/
	}

	if (foundProjectFile) {
		fs.outputFileSync(path.join(options.to, exporter.sysdir() + '-resources', 'files.json'), JSON.stringify({ files: files }, null, '\t'));
	}

	for (let callback of Callbacks.preHaxeCompilation) {
		callback();
	}
	if (options.onlydata) {
		log.info('Exporting only data.');
		// We need to copy assets into project folder for Android native
		if (exporter.sysdir() === 'android-native') {
			// Location of preprocessed assets
			let dataDir = path.join(options.to, exporter.sysdir());
			// Use the same 'safename' as koremake
			let safename = project.name.replace(/ /g, '-');
			let assetsDir = path.resolve(buildDir, safename, 'app', 'src', 'main', 'assets');
			// Create path if it does not exist (although it should)
			fs.ensureDirSync(assetsDir);
			log.info(assetsDir);
			fs.copySync(path.resolve(dataDir), assetsDir);
		}
		return project.name;
	}
	else {
		return await exportProjectFiles(project.name, path.join(options.to, exporter.sysdir() + '-resources'), options, exporter, kore, korehl,
			project.libraries, project.targetOptions, project.defines, project.cdefines, project.stackSize);
	}
}

function isKhaProject(directory: string, projectfile: string) {
	return fs.existsSync(path.join(directory, 'Kha')) || fs.existsSync(path.join(directory, projectfile));
}

async function exportProject(options: Options): Promise<string> {
	if (isKhaProject(options.from, options.projectfile)) {
		return await exportKhaProject(options);
	}
	else {
		log.error('Neither Kha directory nor project file (' + options.projectfile + ') found.');
		return 'Unknown';
	}
}

function runProject(options: any): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		log.info('Running...');
		let run = child_process.spawn(
			path.join(process.cwd(), options.to, 'linux-build', name),
			[],
			{ cwd: path.join(process.cwd(), options.to, 'linux') });

		run.stdout.on('data', function (data: any) {
			log.info(data.toString());
		});

		run.stderr.on('data', function (data: any) {
			log.error(data.toString());
		});

		run.on('close', function (code: number) {
			resolve();
		});
	});
}

export let api = 2;

export async function run(options: Options, loglog: any): Promise<string> {
	if (options.silent) {
		log.silent();
	}
	else {
		log.set(loglog);
	}

	if (!options.kha) {
		let p = path.join(__dirname, '..', '..', '..');
		if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
			options.kha = p;
		}
	}
	else {
		options.kha = path.resolve(options.kha);
	}
	log.info('Using Kha from ' + options.kha);

	if (options.parallelAssetConversion === undefined) {
		options.parallelAssetConversion = 0;
	}

	if (options.haxe3 === undefined) {
		options.haxe3 = false;
	}

	if (!options.haxe) {
		let haxepath = options.haxe3
		? path.join(options.kha, 'Tools', 'haxe', 'v3.x')
		: path.join(options.kha, 'Tools', 'haxe');
		if (fs.existsSync(haxepath) && fs.statSync(haxepath).isDirectory()) options.haxe = haxepath;
	}

	if (!options.krafix) {
		let krafixpath = path.join(options.kha, 'Kore', 'Tools', 'krafix', 'krafix' + sys());
		if (fs.existsSync(krafixpath)) options.krafix = krafixpath;
	}

	if (!options.ogg) {
		let oggpath = path.join(options.kha, 'Tools', 'oggenc', 'oggenc' + sys());
		if (fs.existsSync(oggpath)) options.ogg = oggpath + ' {in} -o {out} --quiet';
	}

	if (!options.mp3) {
		let lamepath = path.join(options.kha, 'Tools', 'lame', 'lame' + sys());
		if (fs.existsSync(lamepath)) options.mp3 = lamepath + ' {in} {out}';
	}

	// if (!options.kravur) {
	//     let kravurpath = path.join(options.kha, 'Tools', 'kravur', 'kravur' + sys());
	//     if (fs.existsSync(kravurpath)) options.kravur = kravurpath + ' {in} {size} {out}';
	// }

	if (!options.aac && options.ffmpeg) {
		options.aac = options.ffmpeg + ' -nostdin -i {in} {out}';
	}

	if (!options.h264 && options.ffmpeg) {
		options.h264 = options.ffmpeg + ' -nostdin -i {in} {out}';
	}

	if (!options.webm && options.ffmpeg) {
		options.webm = options.ffmpeg + ' -nostdin -i {in} {out}';
	}

	if (!options.wmv && options.ffmpeg) {
		options.wmv = options.ffmpeg + ' -nostdin -i {in} {out}';
	}

	if (!options.theora && options.ffmpeg) {
		options.theora = options.ffmpeg + ' -nostdin -i {in} {out}';
	}

	let name = '';
	try {
		name = await exportProject(options);
	}
	catch (err) {
		process.exit(1);
	}

	if (options.target === Platform.Linux && options.run) {
		await runProject(options);
	}

	if (options.compile && options.target === Platform.Android) {
		let gradlew = (process.platform === 'win32') ? 'gradlew.bat' : 'bash';
		let args = (process.platform === 'win32') ? [] : ['gradlew'];
		args.push('assemble');
		let make = child_process.spawn(gradlew, args, { cwd: path.join(options.to, 'android', name) });

		make.stdout.on('data', function (data: any) {
			log.info(data.toString());
		});

		make.stderr.on('data', function (data: any) {
			log.error(data.toString());
		});

		make.on('close', function (code: number) {
			if (code === 0) {

			}
			else {
				log.error('Compilation failed.');
				process.exit(code);
			}
		});
	}

	return name;
}

export function close() {
	if (lastAssetConverter) lastAssetConverter.close();
	if (lastShaderCompiler) lastShaderCompiler.close();
	if (lastHaxeCompiler) lastHaxeCompiler.close();
}
