// Crop the "Pay to the order of" payee strip from a check-front image.
// Validated against Ally's 1176x512 fronts (checks #1769, #1776): the strip
// captures the payee line and excludes signature / account / routing / address.
const { execFileSync } = require('child_process');

const CROP = '780x95+80+150'; // WxH+X+Y on the 1176x512 Ally front

function cropPayee(frontPath, outPath) {
  execFileSync('magick', [frontPath, '-crop', CROP, '+repage', outPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return outPath;
}

module.exports = { cropPayee, CROP };
