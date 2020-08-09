const fs = require("fs");
const child_process = require("child_process");
const express = require("express");
const util = require('util');
const path = require('path');
const config = require("./config");
const exists = util.promisify(fs.exists);
const appendFile = util.promisify(fs.appendFile);
const mkdir = util.promisify(fs.mkdir);
const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const readdir = util.promisify(fs.readdir);
const stat = util.promisify(fs.stat);
const unlink = util.promisify(fs.unlink);
const Gpio = require('onoff').Gpio;
let status = 0; //0 - recording stopped, 1- start recording, 2 - recording in progress
let proc;
let videoInput = config.videoInput;
let blinkInterval = 1000;

logger("Start script");

async function logger(text) {
	if (config.enableLog) {
		const now = new Date();
		const time = `${now.getDate().toString().padStart(2, 0)}-${(now.getMonth() + 1).toString().padStart(2, 0)}-${now.getFullYear()} ${now.getHours().toString().padStart(2, 0)}:${now.getMinutes().toString().padStart(2, 0)}:${now.getSeconds().toString().padStart(2, 0)}`;
		await appendFile("log.txt", `${time} ${text}\n`);
		console.log(text);
	}
}

async function record() {
	if (videoInput === "" || videoInput === undefined || !await exists(videoInput)) {
		logger("Video input not exists");
		return;
	}
	logger("I'm starting a recording attempt");
	if (!await exists(config.videos)) {
		try {
			await mkdir(config.videos, {
				recursive: true
			});
		} catch (err) {
			logger("MKDIR -> " + err);
		}
	}
	let filename;
	if (await exists("count")) {
		try {
			filename = parseInt(await readFile("count", "utf8"));
			if (isNaN(filename)) {
				filename = 0;
			}
		} catch (err) {
			filename = 0;
		}
	} else {
		filename = 0;
	}
	await writeFile("count", filename + 1);
	filename += ".avi";
	status = 1;
	proc = child_process.spawn(config.ffmpeg, ["-loglevel", "error", "-y", "-f", "alsa", "-ac", "1", "-i", config.audioInput, "-i", videoInput, "-c:v", "copy", "-c:a", "aac", "-r", "30", `${config.videos}/${filename}`], { stdio: ["ignore", "ignore", "pipe"] });
	proc.stderr.on("data", (data) => {
		logger("FFMPEG -> " + data);
	});
	proc.on("close", () => {
		logger("Recording stopped");
		status = 0;
		child_process.spawn("sync");
		proc = null;
		clearInterval(timer);
	});

	const timer = setInterval(async () => {
		if (await exists(`${config.videos}/${filename}`)) {
			status = 2;
			logger("Recording in progress");
			clearInterval(timer);
		}
	}, 2000);
}

async function getFiles() {
	let files = [];
	if (await exists(config.videos)) {
		const list = await readdir(config.videos);
		for (const el of list) {
			const stats = await stat(path.join(config.videos, el));
			if (stats.isFile()) {
				files.push(el);
			}
		}
	}
	return files;
}

const app = express();
app.get("/", (req, res) => {
	res.sendFile(__dirname + "/index.html");
});
app.get("/status", (req, res) => {
	res.send(status.toString());
});
app.get("/files", async (req, res) => {
	const files = await getFiles();
	res.send({ files });
});
app.get("/files/:file", async (req, res) => {
	const fileName = path.join(config.videos, req.params.file);
	if (await exists(fileName)) {
		res.download(fileName);
		logger(`Loading file ${fileName}`);
	} else {
		res.sendStatus(404);
		logger(`Not found file ${fileName}`);
	}
});
app.get("/deleteFile/:file", async (req, res) => {
	const fileName = path.join(config.videos, req.params.file);
	if (req.params.file && await exists(fileName)) {
		try {
			await unlink(fileName);
			logger(`File deleted ${fileName}`);
		} catch (err) {
			const files = await getFiles();
			res.status(500).send({ files });
		}
		const files = await getFiles();
		res.status(200).send({ files });
	} else {
		const files = await getFiles();
		res.status(404).send({ files });
	}
});
app.get("/startRecord", (req, res) => {
	if (proc) {
		res.sendStatus(500);
	} else {
		record();
		res.sendStatus(200);
	}
});
app.get("/stopRecord", (req, res) => {
	logger("Attempt to stop recording");
	if (proc) {
		try {
			proc.kill('SIGTERM');
			res.sendStatus(200);
		} catch (err) {
			logger(err);
			res.sendStatus(500);
		}
	} else {
		res.sendStatus(500);
	}
});
app.get("/videoInput", (req, res) => {
	res.send(videoInput);
});

function searchVideoInput() {
	const search = () => {
		return new Promise(async (resolve, reject) => {
			let count = 0;
			let listDev = await readdir("/dev");
			listDev = listDev.filter(el => /video\d+/.test(el));
			if (!listDev.length) {
				reject("Not found video input");
			}
			listDev.forEach(el => {
				const pathVideo = path.join("/dev", el);
				let test = child_process.spawn(config.ffprobe, [pathVideo]);
				test.on("close", (code) => {
					if (!code) {
						resolve(pathVideo);
					}
					count++;
					if (count >= listDev.length) {
						reject("Not found video input");
					}
				});
			});
		});
	};
	const recursiveSearch = async () => {
		try {
			videoInput = await search();
		} catch (err) {
			logger(err);
			videoInput = undefined;
		}
		if (videoInput === "" || videoInput === undefined) {
			setTimeout(() => {
				recursiveSearch();
			}, 10000);
		} else {
			if (config.autoRecord) {
				record();
			}
		}
	};
	recursiveSearch();
}

function start() {
	if (videoInput == "auto") {
		searchVideoInput();
	}
	app.listen(80);
	if (config.autoRecord && videoInput != "auto") {
		record();
	}
	if (config.enableGPIOcontrol) {
		const button = new Gpio(config.buttonPin, 'in', 'both');
		checkPressButton(button, 0);
		const ledIndicator = new Gpio(config.ledIndicatorPin, 'out');
		blink(ledIndicator, 1);
	}
}

function blink(ledIndicator, ledIndicatorValue) {
	ledIndicatorValue = ledIndicatorValue ^ 1;
	setTimeout(() => {
		ledIndicator.write(ledIndicatorValue, () => {
			switch (status) {
				case 0:
					blinkInterval = 1000;
					break;
				case 1:
					blinkInterval = 50;
					break;
				case 2:
					blinkInterval = 200;
					break;
				default: blinkInterval = 1000;
			}
			blink(ledIndicator, ledIndicatorValue);
		});
	}, blinkInterval);
}

function checkPressButton(button, buttonValue) {
	setTimeout(() => {
		button.read((err, value) => {
			if (!err) {
				if (buttonValue != value) {
					if (value == 1) {
						if (proc) {
							logger("Attempt to stop recording");
							try {
								proc.kill('SIGTERM');
							} catch (err) {
								logger(err);
							}
						} else {
							record();
						}
					}
					buttonValue = value;
				}
			}
			checkPressButton(button, buttonValue);
		});
	}, 100);
}

start();