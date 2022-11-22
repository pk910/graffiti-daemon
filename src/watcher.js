
const EventSource = require("eventsource");
const fetch = require("node-fetch");
const fs = require("fs");
const getPixels = require("get-pixels");
const commandLineArgs = require('command-line-args');
const commandLineUsage = require('command-line-usage');

const optionDefinitions = [
  {
    name: 'help',
    description: 'Display this usage guide.',
    alias: 'h',
    type: Boolean
  },
  {
    name: 'image',
    description: 'The input image to process. (PNG format)',
    alias: 'i',
    type: String,
    typeLabel: '{underline image.png}'
  },
  {
    name: 'xpos',
    description: 'Target x-position to draw the image on the graffitiwall',
    alias: 'x',
    type: Number,
    typeLabel: '{underline x}',
    defaultValue: 0
  },
  {
    name: 'ypos',
    description: 'Target y-position to draw the image on the graffitiwall',
    alias: 'y',
    type: Number,
    typeLabel: '{underline y}',
    defaultValue: 0
  },
  {
    name: 'rpchost',
    description: 'The CL RPC host to receive blocks from.',
    alias: 'r',
    type: String,
    typeLabel: '{underline http://127.0.0.1:5052}',
    defaultValue: 'http://127.0.0.1:5052'
  },
  {
    name: 'file',
    description: 'The graffiti file to update.',
    alias: 'f',
    type: String,
    typeLabel: '{underline graffiti.txt}',
    defaultValue: 'graffiti.txt'
  },
  {
    name: 'template',
    description: 'The graffiti template with <gw> as placeholder for the pixel data.',
    alias: 't',
    type: String,
    typeLabel: '{underline MyGraffiti <gw>}',
    defaultValue: '<gw>'
  },
  {
    name: 'state',
    description: 'The path to the state json.',
    alias: 's',
    type: String,
    typeLabel: '{underline graffiti-state.json}',
    defaultValue: 'graffiti-state.json'
  },
  {
    name: 'validators',
    description: 'File with validator pubkeys.',
    alias: 'v',
    type: String,
    typeLabel: '{underline graffiti-state.json}',
    defaultValue: 'graffiti-state.json'
  },
];
const options = commandLineArgs(optionDefinitions);
const convert = (from, to) => str => Buffer.from(str, from).toString(to);
const hexToUtf8 = convert('hex', 'utf8');

var state = null;
var targetImage = null;

main();

function main() {
  if(options['help']) {
    printHelp();
    return;
  }
  
  if(!options['image']) {
    printHelp();
    console.log("No input image specified.");
    console.log("");
    return;
  }

  runDaemon();
  setInterval(() => {}, 5000);
}

function printHelp() {
  console.log(commandLineUsage([
    {
      header: 'Graffiti Daemon',
      content: 'A simple deamon that updates a graffiti file to draw a specific image to the graffitiwall.'
    },
    {
      header: 'Options',
      optionList: optionDefinitions
    }
  ]));
}

async function runDaemon() {
  loadState();
  await parseImage(options['image']);

  var rpchost = options['rpchost'];
  var chainHeadReq = await fetch(rpchost + "/eth/v2/beacon/blocks/head").then(rsp => rsp.json());
  var headSlot = parseInt(chainHeadReq.data.message.slot);
  console.log("Current slot on beacon chain: " + headSlot);

  buildGraffitiFile(getImageDiff());

  if(state.lastSlot && state.lastSlot < headSlot) {
    await syncBlocks(headSlot);
  }

  console.log("start event listener");
  const blockEvtSource = new EventSource(rpchost + "/eth/v1/events?topics=block");

  blockEvtSource.addEventListener("open", function(evt) {
    checkBlockGraffiti();
  });
  blockEvtSource.addEventListener("block", function(evt) {
    checkBlockGraffiti();
  });
}

function parseImage(imageFile) {
  return new Promise((resolve, reject) => {
    console.log("Parse image: " + imageFile);
    getPixels(imageFile, function(err, pixels) {
      if(err)
        return reject(err);
      
      targetImage = {
        width: pixels.shape[0],
        height: pixels.shape[1],
        image: {},
        offsetX: options['xpos'],
        offsetY: options['ypos'],
      }
      var x,y,c;
      for(x = 0; x < pixels.shape[0]; x++) {
        for(y = 0; y < pixels.shape[1]; y++) {
          c = rgbToHex(pixels.get(x, y, 0), pixels.get(x, y, 1), pixels.get(x, y, 2));
          if(c !== "ffffff")
            targetImage.image[x + "-" + y] = c;
        }
      }
  
      console.log("Target Pixels:  " + Object.keys(targetImage.image).length + ", Size: (" + targetImage.width + "," + targetImage.height + "), Offset: (" + targetImage.offsetX + "," + targetImage.offsetY+")");
  
      resolve();
    });
  });
}

function loadState() {
  state = {
    lastSlot: 0,
    image: {}
  };
  if(fs.existsSync(options['state'])) {
    var stateJson = fs.readFileSync(options['state'], "utf8");
    var stateObj = JSON.parse(stateJson);
    Object.assign(state, stateObj);
  }
}

function saveState() {
  fs.writeFileSync(options['state'], JSON.stringify(state));
}

async function syncBlocks(headSlot) {
  for(var slot = state.lastSlot; slot < headSlot; slot++) {
    console.log("syncing slot " + slot + " / " + headSlot);
    await checkBlockGraffiti(slot);
  }
}

function rgbToHex(red, green, blue) {
  const rgb = (red << 16) | (green << 8) | (blue << 0);
  return '' + (0x1000000 + rgb).toString(16).slice(1);
}

async function checkBlockGraffiti(slot) {
  var blockReq = await fetch(options['rpchost'] + "/eth/v2/beacon/blocks/" + (slot ? slot : "head")).then(rsp => rsp.json());
  if(!blockReq.data || !blockReq.data.message)
    return;

  var slot = parseInt(blockReq.data.message.slot);

  //console.log("block", rsp.data.message);
  var graffiti = ("" + hexToUtf8(blockReq.data.message.body.graffiti.substr(2))).replace(/[\u{0080}-\u{10FFFF}]/gu,"");
  console.log("slot " + slot + " graffiti: "+ graffiti);

  var gwMatch = /graffitiwall:([0-9]{1,3}):([0-9]{1,3}):#([0-9a-f]{6})/.exec(graffiti) || /gw:([0-9]{3})([0-9]{3})([0-9a-f]{6})/.exec(graffiti);
  if(gwMatch) {
    var posX = parseInt(gwMatch[1]);
    var posY = parseInt(gwMatch[2]);
    state.image[posX + "-" + posY] = gwMatch[3];
    console.log("pixel change (X: " + posX + ", Y: " + posY + ") #" + gwMatch[3]);

    if(posX >= targetImage.offsetX && posX < targetImage.offsetX + targetImage.width && posY >= targetImage.offsetY && posY < targetImage.offsetY + targetImage.height) {
      // relevant change
      buildGraffitiFile(getImageDiff());
    }
  }

  if(!state.lastSlot || slot > state.lastSlot) {
    state.lastSlot = slot;
  }
  saveState();
}

function getImageDiff() {
  var diff = [];

  var x, y, c;
  var tx, ty, tc;
  for(x = 0; x < targetImage.width; x++) {
    for(y = 0; y < targetImage.height; y++) {
      if(!(c = targetImage.image[x + "-" + y]))
        continue;
      
      tx = targetImage.offsetX + x;
      ty = targetImage.offsetY + y;
      if(!state.image[tx + "-" + ty] || state.image[tx + "-" + ty] !== c) {
        diff.push({
          x: tx,
          y: ty,
          c: c,
        });
      }
    }
  }

  return diff;
}

function buildGraffitiFile(diff) {
  var diffLen = diff.length;
  var getRandomDiff = () => {
    if(!diffLen)
      return null;
    var idx = Math.floor(Math.random() * diffLen);
    return diff[idx];
  };
  var getGraffitiStr = (diff) => {
    var gwt;
    if(diff)
      gwt = "gw:" + diff.x.toString().padStart(3, '0') + diff.y.toString().padStart(3, '0') + diff.c;
    else
      gwt = "";
    return options['template'].replace(/<gw>/, gwt);
  };

  var data = [
    "default: " + getGraffitiStr(getRandomDiff()),
  ];
  var validators = getValidators();
  for(var i = 0; i < validators.length; i++) {
    if(!validators[i].match(/^0x[0-9a-f]{96}$/))
      continue;
    data.push(validators[i] + ": " + getGraffitiStr(getRandomDiff()));
  }

  console.log("Rebuilt graffiti file (" + diffLen + " diffs, " + validators.length + " keys) " + options['file']);

  fs.writeFileSync(options['file'], data.join("\n"));
}

function getValidators() {
  if(!options['validators'])
    return;
  return fs.readFileSync(options['validators'], "utf8").split("\n");
}
