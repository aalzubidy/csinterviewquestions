const express = require('express');
const router = express.Router();
const { logger } = require('../src/logger');
const authorizationSrc = require('../src/authorizationSrc');

/**
 * Custom function to call src file
 * @param {string} srcFunctionName source file function name
 * @param {array} parameters Variables to send with the function
 * @returns {object} response
 */
const callSrcFile = async function callSrc(functionName, parameters, req, res, skipVerify = true) {
  let userCheckPass = false;
  let user = {};
  try {
    if (!skipVerify) {
      user = await authorizationSrc.verifyToken(req);
    }
    userCheckPass = true;
    const data = await authorizationSrc[functionName].apply(this, [...parameters, user]);
    if (data.refreshToken) {
      res.cookie('refresh_token', data.refreshToken, {
        maxAge: 120 * 60 * 1000,
        httpOnly: true,
        secure: false
      });
    }
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
 * @summary Register new users
 */
router.post('/generateUserPin', async (req, res) => {
  callSrcFile('generateUserPin', [req], req, res);
});

/**
 * @summary Login user
 */
router.post('/login', async (req, res) => {
  callSrcFile('login', [req], req, res);
});

/**
 * @summary Logout and delete the stored refresh token by an access token and a refresh tokens
 */
router.delete('/logout', async (req, res) => {
  callSrcFile('logout', [req], req, res, false);
});

/**
 * @summary Get a new access token using existing refresh token cookie by refresh token
 */
router.post('/logoutByCookie', async (req, res) => {
  callSrcFile('logoutByCookie', [req], req, res);
});

/**
 * @summary Get a new access token using existing refresh token
 */
router.post('/renewToken', async (req, res) => {
  callSrcFile('renewToken', [req], req, res);
});

/**
 * @summary Get a new access token using existing refresh token cookie
 */
router.post('/renewTokenByCookie', async (req, res) => {
  callSrcFile('renewTokenByCookie', [req], req, res);
});

/**
 * @summary Check if username is in database
 */
router.post('/checkUsernameAvailablity', async (req, res) => {
  callSrcFile('checkUsernameAvailablity', [req], req, res);
});

/**
 * @summary Get user from token
 */
router.get('/getTokenUser', async (req, res) => {
  callSrcFile('getTokenUser', [], req, res, false);
});

module.exports = router;
