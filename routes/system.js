const express = require('express');
const router = express.Router();
const { logger } = require('../src/logger');
const authorizationSrc = require('../src/authorizationSrc');
const systemSrc = require('../src/systemSrc');

/**
 * Custom function to call src file
 * @param {string} srcFunctionName source file function name
 * @param {array} parameters Variables to send with the function
 * @returns {object} response
 */
const callSrcFile = async function callSrc(functionName, parameters, req, res, skipVerify = false) {
  let userCheckPass = false;
  try {
    let user = {};
    if (!skipVerify) {
      user = await authorizationSrc.verifyToken(req);
    }
    userCheckPass = true;
    const data = await systemSrc[functionName].apply(this, [...parameters, user]);
    res.status(200).json({
      data
    });
  } catch (error) {
    logger.error(error);
    if (error && error.code) {
      res.status(error.code).json({
        error
      });
    } else if (error && !userCheckPass) {
      res.status(401).json({
        error: {
          code: 401,
          message: 'Not authorized'
        }
      });
    } else {
      res.status(500).json({
        error: {
          code: 500,
          message: `Could not process ${req.originalUrl} request`
        }
      });
    }
  }
};

/**
 * @summary Get positions stats
 */
router.get('/stats/positions', async (req, res) => {
  callSrcFile('getPositionsStats', [], req, res, true);
});

/**
 * @summary Get companies stats
 */
router.get('/stats/companies', async (req, res) => {
  callSrcFile('getCompaniesStats', [], req, res, true);
});

/**
 * @summary Get system version
 */
router.get('/system/version', async (req, res) => {
  callSrcFile('getSystemVersion', [], req, res, true);
});

/**
 * @summary Get system ping
 */
router.get('/system/ping', async (req, res) => {
  callSrcFile('systemPing', [], req, res, true);
});

module.exports = router;
