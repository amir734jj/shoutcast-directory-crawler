const axios = require('axios');
const cheerio = require('cheerio');
const FormData = require('form-data');
const fs = require('fs').promises;
const { chunkPromise, PromiseFlavor } = require('chunk-promise');
const cliProgress = require('cli-progress');
const pt = require('promise-timeout');

const axiosTimeout = 3000;
const promiseTimeout = 5000;

const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);

async function getGenres() {
  const { data } = await axios.get('https://directory.shoutcast.com/');
  const $ = cheerio.load(data);
  return $('a').map((_, el) => $(el).attr('href')).toArray()
    .filter((x) => x)
    .filter((x) => x.startsWith('/Genre?name='))
    .map((x) => x.replace('/Genre?name=', ''))
    .map((x) => decodeURIComponent(x));
}

async function getRadioByGenre(genre) {
  const formData = new FormData();
  formData.append('genrename', genre);
  const headers = {
    ...formData.getHeaders(),
    'Content-Length': formData.getLengthSync(),
  };
  const { data } = await axios.post('https://directory.shoutcast.com/Home/BrowseByGenre', formData, { headers });
  return data;
}

async function categorizeGenres(genres) {
  const attributesGenres = await chunkPromise(genres.map((genre) => async () => ({
    genre,
    attributes: await getRadioByGenre(genre),
  })), {
    concurrent: 1,
    promiseFlavor: PromiseFlavor.PromiseAll,
  });
  return attributesGenres.reduce((acc, x) => {
    const { genre, attributes } = x;
    acc[genre] = attributes;
    return acc;
  }, {});
}

async function downloadM3a(id) {
  try {
    const { data } = await pt.timeout(axios.get(`http://yp.shoutcast.com/sbin/tunein-station.m3u?id=${id}`, { timeout: axiosTimeout }), promiseTimeout);
    return data.split('\n').filter((line) => line.startsWith('http'));
  } catch (err) {
    return [];
  }
}

async function streamUrlIsValid(url) {
  try {
    await pt.timeout(axios.head(url, { timeout: axiosTimeout }), promiseTimeout);
    return true;
  } catch (_) {
    return false;
  }
}

async function filterByAvailablity(attributedGenres) {
  const result = {};
  const total = Object.keys(attributedGenres)
    .map((key) => attributedGenres[key].length)
    .reduce((acc, x) => acc + x, 0);
  progressBar.start(total, 0);

  await chunkPromise(Object.keys(attributedGenres).map((genre) => async () => {
    const streams = attributedGenres[genre];
    const availableStreams = [];

    await chunkPromise(streams.map((stream) => async () => {
      const urls = await downloadM3a(stream.ID);
      let collected = false;
      // eslint-disable-next-line no-restricted-syntax
      for (const url of urls) {
        // eslint-disable-next-line no-await-in-loop
        if (!collected && url && await streamUrlIsValid(url)) {
          availableStreams.push({ ...stream, url });
          collected = true;
        }
      }

      progressBar.increment();
    }), {
      concurrent: 10,
      promiseFlavor: PromiseFlavor.PromiseAll,
    });

    if (availableStreams.length) {
      result[genre] = availableStreams;
    }

    progressBar.updateETA();
  }), {
    concurrent: 5,
    promiseFlavor: PromiseFlavor.PromiseAll,
  });

  return result;
}

async function main() {
  const genres = await getGenres();
  const attributedGenres = await categorizeGenres(genres);
  const filteredAttributedGenres = await filterByAvailablity(attributedGenres);
  await fs.writeFile('shoutcast-directory.json', JSON.stringify(filteredAttributedGenres, null, 2), 'utf8');
}

main().then(() => {
  progressBar.stop();
});
