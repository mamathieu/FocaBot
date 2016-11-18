moment = require 'moment'
mathjs = require 'mathjs'

class Util
  parseTime: (time)->
    t = time.split(':').reverse()
    moment.duration {
      seconds: t[0]
      minutes: t[1]
      hours:   t[2]
    }
    .asSeconds()

  evalExpr: (e)->
    expr = e
    for param in arguments
      e = e.replace '{n}', param if typeof param is 'number'
    mathjs.eval(e)

module.exports = Util