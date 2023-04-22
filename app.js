const axios = require('axios');
const cheerio = require('cheerio');
const FormData = require('form-data');
const fs = require('fs').promises;
const { chunkPromise, PromiseFlavor } = require('chunk-promise');

async function getGenres() {
  const { data } = await axios.get('https://directory.shoutcast.com/');
  const $ = cheerio.load(data);
  return $('a').map((_, el) => $(el).attr('href')).toArray()
    .filter(x => x)
    .filter(x => x.startsWith('/Genre?name='))
    .map(x => x.replace('/Genre?name=', ''))
    .map(x => decodeURIComponent(x));
}

async function getRadioByGenre(genre) {
  let formData = new FormData();
  formData.append('genrename', genre);
  const headers = {
    ...formData.getHeaders(),
    "Content-Length": formData.getLengthSync()
  };
  const { data } = await axios.post('https://directory.shoutcast.com/Home/BrowseByGenre', formData, { headers });
  return data;
}

async function categorizeGenres(genres) {
  const attributesGenres = await chunkPromise(genres.map(genre => async () => ({
    genre,
    attributes: await getRadioByGenre(genre)
  })), {
    concurrent: 1,
    promiseFlavor: PromiseFlavor.PromiseAll
  });
  return attributesGenres.reduce((acc, x) => {
    const { genre, attributes } = x;
    acc[genre] = attributes;
    return acc;
  }, {});
}

async function downloadM3a(id) {
  const { data } = await axios.get(`http://yp.shoutcast.com/sbin/tunein-station.m3u?id=${id}`);
  return data.split('\n').filter(line => line.startsWith('http'))[0];
}

async function streamUrlIsValid(url) {
  try {
    await axios.head(url);
    return true;
  } catch (_) {
    return false;
  }
}

async function filterByAvailablity(attributedGenres) {
  let result = {};
  for (genre in attributedGenres) {
    let streams = attributedGenres[genre];
    let availableStreams = [];

    for (stream in streams) {
      let url = await downloadM3a(stream.id);
      if (await streamUrlIsValid(url)) {
        availableStreams.append(stream);
      }
    }

    if (availableStreams.length) {
      result[genre] = availableStreams;
    }
  }

  return result;
}

async function main() {
  const genres = await getGenres();
  const attributedGenres = await categorizeGenres(genres);
  const filteredAttributedGenres = await filterByAvailablity(attributedGenres);
  await fs.writeFile('shoutcast-directory.json', JSON.stringify(filteredAttributedGenres, null, 2), 'utf8');
}

main();