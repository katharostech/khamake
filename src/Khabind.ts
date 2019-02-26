import * as child_process from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import * as Throttle from 'promise-parallel-throttle';

import * as log from './log';
import { executeHaxe } from './Haxe';
import { Library, Project } from './Project';
import { Options } from './Options';

export class KhabindOptions {
    idlFile: string;
    nativeLib: string;
    sourcesDir: string;
    chopPrefix: string;
    autoGC: boolean;
    includes: Array<string>;
    emccOptimizationLevel: string;
    emccArgs: Array<string>;
}

export class KhabindLib {
	libRoot: string;
	options: KhabindOptions;
}

export async function generateBindings(libRoot:string, bindOpts:KhabindOptions, options:Options, korehl:boolean) {
    if (options.target != 'krom' && !options.target.endsWith('html5') && !korehl) {
        log.info(`WARNING: Auto-binding library "${path.basename(libRoot)}" to Haxe for target ${options.target} is not supported.`);
        return;
    }

	log.info(`Generating bindings for: ${path.basename(libRoot)}`);

    // Evaluate file modified times to determine what needs to be recompiled
    let recompileAll = false;
    let rebuildBindings = false;
    let khafile = path.resolve(libRoot, 'khafile.js');
    let webidlFile = path.resolve(libRoot, bindOpts.idlFile);
    let jsLibrary = path.resolve(libRoot, 'khabind', bindOpts.nativeLib + '.js');
    if (fs.existsSync(jsLibrary)) {
        if (fs.statSync(khafile).mtime > fs.statSync(jsLibrary).mtime) {
            recompileAll = true; // khabind.json file has been updated, recompile everything
        } else if (fs.statSync(webidlFile).mtime > fs.statSync(jsLibrary).mtime) {
            rebuildBindings = true; // webidl bindings have been update, recompile bindings
        }
    } else {
        rebuildBindings = true;
    }

    // Genreate HL/JS Haxe bindings
    if (recompileAll || rebuildBindings) {
		// Call Haxe macro to generate bindings
        await executeHaxe(libRoot, options.haxe, [
            '-cp', path.resolve(options.kha, 'Sources'),
            '-cp', path.resolve(options.kha, 'Tools', 'webidl'),
            '--macro', `kha.internal.WebIdlBinder.generate(${recompileAll})`,
        ]);
    }

	// Create a Korefile for HL/C builds of the library
	var korefile = path.resolve(libRoot, 'korefile.js');
	var content = `let project = new Project('${path.basename(libRoot)}', __dirname);\n`;
	content += `project.addFile('${bindOpts.sourcesDir}/**');\n`;
	content += `project.addIncludeDir('${bindOpts.sourcesDir}');\n`;
	content += `project.addFile('khabind/${bindOpts.nativeLib}.cpp');\n`;
	content += 'resolve(project);\n';
	fs.writeFile(korefile, content);

    // Compile C++ library to JavaScript for Krom/HTML5
	if (options.target == 'krom' || options.target.endsWith('html5')) {
		let emsdk:string = "";
		let emcc:string = "";
		function ensureEmscripten() {
			if (emsdk != "") return;
			emsdk = process.env.EMSCRIPTEN;
			if (emsdk == undefined) {
				let msg = 'EMSCRIPTEN environment variable not set cannot compile C++ library for Javascript';
				log.error(msg);
				throw msg;
			}
			emcc = path.join(emsdk, 'emcc');
		}
		let optimizationArg = bindOpts.emccOptimizationLevel ? '-O' + bindOpts.emccOptimizationLevel : '-O2';
		let sourcesDir = path.resolve(libRoot, bindOpts.sourcesDir);
		let sourceFiles:string[] = [];
		let targetFiles:string[] = [];
		let invalidateCache = false;

        // Source scan helper function
		function addSources(dir:string) {
			if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
			for (let item of fs.readdirSync(dir)) {
				if (fs.statSync(path.resolve(dir, item)).isDirectory()) {
					addSources(path.resolve(dir, item));

				} else if (item.endsWith('.cpp') || item.endsWith('.c')) {
					sourceFiles.push(path.resolve(dir, item));
				}
			}
		}

		// Search source dirs for C/C++ files
		addSources(sourcesDir);
		addSources(path.resolve(libRoot, 'khabind'));

        // Compiler helper function
		function compileSource(file:string) {
			return new Promise<void>(async (resolve, reject:(err:string)=>void) => {
				let needsRecompile = false;
                let relativeSource = path.relative(libRoot, file);
                let relativeTargetFile = relativeSource.substr(0, file.length - path.extname(file).length) + ".bc";
                let targetFile = path.resolve(libRoot, 'khabind', 'bytecode', relativeTargetFile);
                fs.ensureDirSync(path.dirname(targetFile));
				targetFiles.push(targetFile);

                // Check file modifications times to determine whether to recompile source file
				if (await fs.pathExists(targetFile)) {
					if (recompileAll || (await fs.stat(file)).mtime.getTime() > (await fs.stat(targetFile)).mtime.getTime()) {
						ensureEmscripten();
						needsRecompile = invalidateCache = true;
					}
                } else { ensureEmscripten(); needsRecompile = invalidateCache = true;}

                // Compile source file using Emscripten
				if (needsRecompile) {
					log.info(`    Compiling ${path.relative(libRoot, file)}`);
					let stderr = "";
					let run = child_process.spawn(
						emcc, [optimizationArg, `-I${sourcesDir}`, '-c', file, '-o', targetFile],
						{cwd: libRoot}
					);

					run.stderr.on('data', function (data: any) {
						stderr += data.toString();
					});

					run.on('close', function (code: number) {
						if (stderr != "") {
							reject(stderr);
						} else {
							resolve();
						}
					});
				} else {
					resolve();
				}
			});
		}

        // Run compiler jobs
		let jobs = sourceFiles.map(file => () => compileSource(file));
		await Throttle.all(jobs, {
			maxInProgress: os.cpus().length,
			failFast: true
		}).catch(err => {
			log.info(err);
		});

		// Link bytecode to final JavaScript library
		if (invalidateCache || !fs.existsSync(path.join(libRoot, 'khabind', bindOpts.nativeLib + '.js'))) {
			log.info('    Linking Javascript Library');
			ensureEmscripten();
			let args = [
				optimizationArg,
				'-s', 'EXPORT_NAME=' + bindOpts.nativeLib, '-s', 'MODULARIZE=1', '-s', 'SINGLE_FILE=1', '-s', 'WASM=0',
				...bindOpts.emccArgs.reduce((a, b) => {return a + ' ' + b}).split(" "), // Remove spaces and split emccArgs
				'-o', path.join('khabind', bindOpts.nativeLib) + '.js'
			];
			log.info('    running emcc: emcc ' + args.join(' '));
			let output = child_process.spawnSync(emcc,
				[...targetFiles, ...args],
				{cwd:libRoot}
			);
			if (output.stderr.toString() !== '') {
				log.error(output.stderr.toString());
			}
			if (output.stdout.toString() !== '') {
				log.info(output.stdout.toString());
			}
		}
	} // if (options.target == 'krom' || options.target.endsWith('html5'))

	log.info(`Done generating bindings for: ${path.basename(libRoot)}`);
}
