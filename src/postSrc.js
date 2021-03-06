const moment = require('moment');
const Filter = require('bad-words');
const randomstring = require('randomstring');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const filter = new Filter();
const { logger } = require('./logger');
const db = require('../db/db');
const fileSrc = require('./fileSrc');
const { isHttpErrorCode, sendEmailText, parseFormDataWithFile } = require('./tools');

/**
 * @function newPost
 * @summary Create a new post
 * @param {object} req Http request
 * @param {object} user User information
 * @returns {object} newPostResults
 * @throws {object} errorCodeAndMsg
 */
const newPost = async function newPost(req, user) {
  let fileUrl = '';
  try {
    // req = await parseFormDataWithFile(req); // use with GCS

    // Upload post's attached file locally
    const uploadFileResults = await fileSrc.uploadFileLocally(req, 'posts');
    req = uploadFileResults.req;
    fileUrl = uploadFileResults.fileUrl ? uploadFileResults.fileUrl : '';

    const { interviewDate } = req.body;
    let {
      title,
      company,
      position,
      body,
    } = req.body;

    // Check if there is no email or password
    if (!title || !interviewDate || !company || !position) {
      throw { code: 400, message: 'Please provide title, interview date, company, position' };
    }

    title = filter.clean(title);
    company = filter.clean(company);
    position = filter.clean(position);
    body = body ? filter.clean(body) : body;

    // Upload post's attached file
    // const uploadFileResults = await fileSrc.uploadFileLocally(req, 'posts'); // Use with GCS

    // Get date
    const createDate = moment().format('MM/DD/YYYY');

    // Create a pin
    const pin = randomstring.generate(12);

    // Hash the pin
    const pinHashed = await bcrypt.hash(pin, 12);

    // Create a new post in the databsae
    const postQuery = await db.query('insert into posts(title, interview_date, company, position, body, status, pin, create_date) VALUES($1, $2, $3, $4, $5, $6, $7, $8) returning id', [title, interviewDate, company, position, body, 'published', pinHashed, createDate]);
    logger.debug({ label: 'create new post query response', results: postQuery.rows });

    // Add post and file in the database
    if (uploadFileResults.fileUrl) {
      await fileSrc.addDocumentFileUrl(postQuery.rows[0].id, uploadFileResults.fileUrl, 'post');
    }

    // Send an email with the pin
    const subject = 'Post Published - You\'re Admin PIN is Here!';
    const message = `You're post is published, please use this PIN to edit or delete your post in the future!
    Post Id: ${postQuery.rows[0].id}
    Post Title: ${title}
    Post PIN: ${pin}`;
    const sendEmail = await sendEmailText(user.email, subject, message);

    if (sendEmail) {
      return { message: 'Post have been published successfully, and email has been sent with the your admin pin.', id: postQuery.rows[0].id };
    } else {
      throw { code: 500, message: 'Could not send post pin email' };
    }
  } catch (error) {
    if (fileUrl) fs.unlinkSync(`${path.resolve(__dirname, '../public')}${fileUrl}`);

    if (error.code && isHttpErrorCode(error.code)) {
      logger.error(error);
      throw error;
    }
    const userMsg = 'Could not create post';
    logger.error({ userMsg, error });
    throw { code: 500, message: userMsg };
  }
};

/**
 * @function setPostStatus
 * @summary Set a post's status in database
 * @param {number} postId Post's id
 * @param {string} status Post's status
 * @returns {object} setPostResults
 * @throws {boolean} false
 */
const setPostStatus = async function setPostStatus(postId, status) {
  if (!postId || !status) throw { code: 400, message: 'Please provide a post id and status' };

  const queryResults = await db.query('update posts set status=$1 where id=$2 returning id', [status, postId]);
  logger.debug({ label: 'set a post\'s status response', results: queryResults.rows });

  if (queryResults && queryResults.rows[0]) return queryResults.rows[0];
  else return false;
};

/**
 * @function incrementPostViews
 * @summary Set a post's views in database
 * @param {number} postId Post's id
 * @returns {object} setPostResults
 * @throws {boolean} false
 */
const incrementPostViews = async function incrementPostViews(postId) {
  if (!postId) throw { code: 400, message: 'Please provide a post id' };

  const queryResults = await db.query('update posts set views=views+1 where id=$1 returning views', [postId]);
  logger.debug({ label: 'set a post\'s views response', results: queryResults.rows });

  if (queryResults && queryResults.rows[0]) return queryResults.rows[0];
  else return false;
};

/**
 * @function getPost
 * @summary Get a post from database
 * @param {number} postId Post's id
 * @returns {object} getPostResults
 * @throws {boolean} false
 */
const getPost = async function getPost(postId) {
  if (!postId) throw { code: 400, message: 'Please provide a post id' };

  const queryResults = await db.query('select * from posts where id=$1', [postId]);
  logger.debug({ label: 'get a post query response', results: queryResults.rows });

  if (queryResults && queryResults.rows[0]) return queryResults.rows[0];
  else return false;
};

/**
 * @function verifyPostPin
 * @summary Verify if a post and pin matches
 * @param {string} postId Post id
 * @param {string} postPin Post pin
 * @returns {boolean} postPinResults
 * @throws {object} errorCodeAndMsg
 */
const verifyPostPin = async function verifyPostPin(postId, postPin) {
  try {
    if (!postId || !postPin) throw { code: 400, message: 'Please provide a post id and it\'s admin pin' };

    // Get post
    const postDb = await getPost(postId);
    if (!postDb) throw { code: 404, message: 'Could not find requested post' };

    // Compare post pin to the pin
    const postHash = postDb.pin;
    const validatePin = await bcrypt.compare(postPin, postHash);
    if (!validatePin) throw { code: 401, message: 'Please check pin and post' };
    else return true;
  } catch (error) {
    if (error.code && isHttpErrorCode(error.code)) {
      logger.error(error);
      return false;
    }

    const userMsg = 'Could not run post pin verification, returning false';
    logger.error({ userMsg, error });
    return false;
  }
};

/**
 * @function getPostExternal
 * @summary Get a post from database
 * @param {number} postId Post's id
 * @param {object} user User information
 * @returns {object} getPostResults
 * @throws {object} errorCodeAndMsg
 */
const getPostExternal = async function getPostExternal(postId, user) {
  try {
    if (!postId) throw { code: 400, message: 'Please provide a post id' };

    const queryResults = await db.query('select id, title, create_date, interview_date, company, body, position, votes_up, votes_down, views from posts where id=$1 and status=\'published\'', [postId]);
    logger.debug({ label: 'get a post query response', results: queryResults.rows });

    if (queryResults && queryResults.rows[0]) {
      incrementPostViews(postId);
      return queryResults.rows[0];
    } else return false;
  } catch (error) {
    if (error.code && isHttpErrorCode(error.code)) {
      logger.error(error);
      throw error;
    }
    const userMsg = 'Could not get a post';
    logger.error({ userMsg, error });
    throw { code: 500, message: userMsg };
  }
};

/**
 * @function deletePost
 * @summary Delete a post
 * @param {number} postId Post's id
 * @param {string} pin Post's pin
 * @param {object} user User information
 * @returns {object} postDeleteResults
 * @throws {object} errorCodeAndMsg
 */
const deletePost = async function deletePost(postId, postPin, user) {
  try {
    if (!postId || !postPin) throw { code: 400, message: 'Please provide a post id and it\'s admin pin' };

    // Verify post pin
    const verifyPin = await verifyPostPin(postId, postPin);
    if (!verifyPin) throw { code: 401, message: 'Please check pin and post' };

    await fileSrc.deleteDocumentFilesByDocumentId(postId, postPin, 'post');

    // Delete post
    const setPostDb = await setPostStatus(postId, 'deleted');
    if (!setPostDb) throw { code: 500, message: 'Could not delete post' };

    return { 'message': 'Deleted post successfully' };
  } catch (error) {
    if (error.code && isHttpErrorCode(error.code)) {
      logger.error(error);
      throw error;
    }
    const userMsg = 'Could not delete post';
    logger.error({ userMsg, error });
    throw { code: 500, message: userMsg };
  }
};

/**
 * @function modifyPost
 * @summary Modify a post
 * @param {number} postId Post's id
 * @param {string} pin Post's pin
 * @param {string} title Title
 * @param {string} interviewDate Interview date
 * @param {string} company Company
 * @param {string} position Position or title
 * @param {string} body Body or description
 * @param {object} user User information
 * @returns {object} newPostResults
 * @throws {object} errorCodeAndMsg
 */
const modifyPost = async function modifyPost(postId, postPin, title, interviewDate, company, position, body, user) {
  try {
    if (!postId || !postPin) throw { code: 400, message: 'Please provide a post id and it\'s admin pin' };

    // Verify post pin
    const verifyPin = await verifyPostPin(postId, postPin);
    if (!verifyPin) throw { code: 401, message: 'Please check pin and post' };

    // Clean language
    title = title ? filter.clean(title) : title;
    company = company ? filter.clean(company) : company;
    position = position ? filter.clean(position) : position;
    body = body ? filter.clean(body) : body;

    // Update post
    let count = 1;
    let updateString = 'update posts set(';
    const updateArray = [];

    if (title) updateString = `${updateString} title`;
    if (company) updateString = `${updateString}, company`;
    if (position) updateString = `${updateString}, position`;
    if (body) updateString = `${updateString}, body`;
    if (interviewDate) updateString = `${updateString}, interview_date`;

    updateString = `${updateString})=(`;

    if (title) {
      updateString = `${updateString} $${count}`;
      count += 1;
      updateArray.push(title);
    }
    if (company) {
      updateString = `${updateString}, $${count}`;
      count += 1;
      updateArray.push(company);
    }
    if (position) {
      updateString = `${updateString}, $${count}`;
      count += 1;
      updateArray.push(position);
    }
    if (body) {
      updateString = `${updateString}, $${count}`;
      count += 1;
      updateArray.push(body);
    }
    if (interviewDate) {
      updateString = `${updateString}, $${count}`;
      count += 1;
      updateArray.push(interviewDate);
    }

    updateString = `${updateString}) where id=$${count} returning id`;
    updateArray.push(postId);

    const updateQuery = await db.query(updateString, updateArray);
    logger.debug({ label: 'update a post query response', results: updateQuery.rows });

    return { 'message': 'Updated post successfully', id: updateQuery.rows[0] };
  } catch (error) {
    if (error.code && isHttpErrorCode(error.code)) {
      logger.error(error);
      throw error;
    }
    const userMsg = 'Could not update post';
    logger.error({ userMsg, error });
    throw { code: 500, message: userMsg };
  }
};

/**
 * @function modifyPostAttachments
 * @summary Update post files by post id
 * @param {number} postId Post id
 * @param {string} postPin Post management password
 * @param {object} req Http request
 * @param {object} user User's information
 * @returns {object} updatePostAttachmentsResults
 * @throws {object} errorCodeAndMsg
 */
const modifyPostAttachments = async function modifyPostAttachments(postId, postPin, req, user) {
  let fileUrl = '';
  try {
    // Check if there is no document id or document type
    if (!postId || !postPin) throw { code: 400, message: 'Please provide post id, and post management password.' };

    // Verify post pin
    const verifyPin = await verifyPostPin(postId, postPin);
    if (!verifyPin) throw { code: 401, message: 'Please check pin and post' };

    // Upload post's attached file locally
    const uploadFileResults = await fileSrc.uploadFileLocally(req, 'posts');
    req = uploadFileResults.req;
    fileUrl = uploadFileResults.fileUrl ? uploadFileResults.fileUrl : '';

    // Get files url
    const queryFiles = await db.query('select * from post_files where post_id=$1', [postId]);
    logger.debug({ label: 'query post attachments files response', results: queryFiles.rows });

    // Delete files from local server
    queryFiles.rows.forEach(async (item) => {
      await fs.unlinkSync(`${path.resolve(__dirname, '../public')}${item.file_url}`);
    });

    // Delete files from db
    const queryResults = await db.query('delete from post_files where post_id=$1', [postId]);
    logger.debug({ label: 'delete post attachments files response', results: queryResults.rows });

    // Add post and file in the database
    let addDocumentFileUrlResults = {};
    if (uploadFileResults.fileUrl) {
      addDocumentFileUrlResults = await fileSrc.addDocumentFileUrl(postId, uploadFileResults.fileUrl, 'post');
    }

    return { message: 'Post attachments updated successfully', results: addDocumentFileUrlResults };
  } catch (error) {
    if (fileUrl) fs.unlinkSync(`${path.resolve(__dirname, '../public')}${fileUrl}`);

    if (error.code && isHttpErrorCode(error.code)) {
      logger.error(error);
      throw error;
    }
    const userMsg = 'Could not delete document file url by post/comment id';
    logger.error({ userMsg, error });
    throw { code: 500, message: userMsg };
  }
};

/**
 * @function getAllPostsExternal
 * @summary Get all posts from database
 * @param {string} sortKey Sort key (create_date, interview_date or views)
 * @param {string} sortOrder Sort order (asc or desc)
 * @param {number} limit
 * @param {number} offset
 * @param {object} user User information
 * @returns {object} getPostsResults
 * @throws {object} errorCodeAndMsg
 */
const getAllPostsExternal = async function getAllPostsExternal(sortKey, sortOrder, limit, offset, user) {
  try {
    if (!sortKey || !sortOrder || !limit || (!offset && offset !== 0)) throw { code: 400, message: 'Please enter required sortKey (create_date, interview_date, or views), sort order (asc, or desc) limit and an offset' };

    if (sortKey !== 'create_date' && sortKey !== 'interview_date' && sortKey !== 'views') throw { code: 400, message: 'Please select required sortKey (create_date, interview_date, or views)' };

    if (sortOrder !== 'asc' && sortOrder !== 'desc') throw { code: 400, message: 'Please select required sortOrder (asc or desc)' };

    if (limit > 50) throw { code: 400, message: 'Maximum limit is 50' };

    const queryResults = await db.query(`select id, title, create_date, interview_date, company, body, position, votes_up, votes_down, views from posts where status='published' order by ${sortKey} ${sortOrder} limit $1 offset $2`, [limit, offset]);
    logger.debug({ label: 'get all posts query response', results: queryResults.rows });

    if (queryResults && queryResults.rows[0]) {
      return queryResults.rows;
    } else return false;
  } catch (error) {
    if (error.code && isHttpErrorCode(error.code)) {
      logger.error(error);
      throw error;
    }
    const userMsg = 'Could not get all posts';
    logger.error({ userMsg, error });
    throw { code: 500, message: userMsg };
  }
};

/**
 * @function getAllCompanyPostsExternal
 * @summary Get all company's posts from database
 * @param {string} sortKey Sort key (create_date, interview_date or views)
 * @param {string} sortOrder Sort order (asc or desc)
 * @param {number} limit
 * @param {number} offset
 * @param {string} company Company name
 * @param {object} user User information
 * @returns {object} getPostsResults
 * @throws {object} errorCodeAndMsg
 */
const getAllCompanyPostsExternal = async function getAllCompanyPostsExternal(sortKey, sortOrder, limit, offset, company, user) {
  try {
    if (!sortKey || !sortOrder || !limit || (!offset && offset !== 0) || !company) throw { code: 400, message: 'Please enter required sortKey (create_date, interview_date, or views), sort order (asc, or desc) limit, offset, and a company' };

    if (sortKey !== 'create_date' && sortKey !== 'interview_date' && sortKey !== 'views') throw { code: 400, message: 'Please select required sortKey (create_date, interview_date, or views)' };

    if (sortOrder !== 'asc' && sortOrder !== 'desc') throw { code: 400, message: 'Please select required sortOrder (asc or desc)' };

    if (limit > 50) throw { code: 400, message: 'Maximum limit is 50' };

    const queryResults = await db.query(`select id, title, create_date, interview_date, company, body, position, votes_up, votes_down, views from posts where company=$1 and status='published' order by ${sortKey} ${sortOrder} limit $2 offset $3`, [company, limit, offset]);
    logger.debug({ label: 'get all company posts query response', results: queryResults.rows });

    if (queryResults && queryResults.rows[0]) {
      return queryResults.rows;
    } else return false;
  } catch (error) {
    if (error.code && isHttpErrorCode(error.code)) {
      logger.error(error);
      throw error;
    }
    const userMsg = 'Could not get all company posts';
    logger.error({ userMsg, error });
    throw { code: 500, message: userMsg };
  }
};

/**
 * @function getAllPositionPostsExternal
 * @summary Get all positions's posts from database
 * @param {string} sortKey Sort key (create_date, interview_date or views)
 * @param {string} sortOrder Sort order (asc or desc)
 * @param {number} limit
 * @param {number} offset
 * @param {string} position Position name
 * @param {object} user User information
 * @returns {object} getPostsResults
 * @throws {object} errorCodeAndMsg
 */
const getAllPositionPostsExternal = async function getAllPositionPostsExternal(sortKey, sortOrder, limit, offset, position, user) {
  try {
    if (!sortKey || !sortOrder || !limit || (!offset && offset !== 0) || !position) throw { code: 400, message: 'Please enter required sortKey (create_date, interview_date, or views), sort order (asc, or desc) limit, offset, and a position' };

    if (sortKey !== 'create_date' && sortKey !== 'interview_date' && sortKey !== 'views') throw { code: 400, message: 'Please select required sortKey (create_date, interview_date, or views)' };

    if (sortOrder !== 'asc' && sortOrder !== 'desc') throw { code: 400, message: 'Please select required sortOrder (asc or desc)' };

    if (limit > 50) throw { code: 400, message: 'Maximum limit is 50' };

    const queryResults = await db.query(`select id, title, create_date, interview_date, company, body, position, votes_up, votes_down, views from posts where position=$1 and status='published' order by ${sortKey} ${sortOrder} limit $2 offset $3`, [position, limit, offset]);
    logger.debug({ label: 'get all position posts query response', results: queryResults.rows });

    if (queryResults && queryResults.rows[0]) {
      return queryResults.rows;
    } else return false;
  } catch (error) {
    if (error.code && isHttpErrorCode(error.code)) {
      logger.error(error);
      throw error;
    }
    const userMsg = 'Could not get all position posts';
    logger.error({ userMsg, error });
    throw { code: 500, message: userMsg };
  }
};

/**
 * @function getAllPositionCompanyPostsExternal
 * @summary Get all position's company's posts from database
 * @param {string} sortKey Sort key (create_date, interview_date or views)
 * @param {string} sortOrder Sort order (asc or desc)
 * @param {number} limit
 * @param {number} offset
 * @param {string} position Position name
 * @param {string} position Company name
 * @param {object} user User information
 * @returns {object} getPostsResults
 * @throws {object} errorCodeAndMsg
 */
const getAllPositionCompanyPostsExternal = async function getAllPositionCompanyPostsExternal(sortKey, sortOrder, limit, offset, position, company, user) {
  try {
    if (!sortKey || !sortOrder || !limit || (!offset && offset !== 0) || !position) throw { code: 400, message: 'Please enter required sortKey (create_date, interview_date, or views), sort order (asc, or desc) limit, offset, and a position' };

    if (sortKey !== 'create_date' && sortKey !== 'interview_date' && sortKey !== 'views') throw { code: 400, message: 'Please select required sortKey (create_date, interview_date, or views)' };

    if (sortOrder !== 'asc' && sortOrder !== 'desc') throw { code: 400, message: 'Please select required sortOrder (asc or desc)' };

    if (limit > 50) throw { code: 400, message: 'Maximum limit is 50' };

    const queryResults = await db.query(`select id, title, create_date, interview_date, company, body, position, votes_up, votes_down, views from posts where position=$1 and company=$2 and status='published' order by ${sortKey} ${sortOrder} limit $3 offset $4`, [position, company, limit, offset]);
    logger.debug({ label: 'get all position posts query response', results: queryResults.rows });

    if (queryResults && queryResults.rows[0]) {
      return queryResults.rows;
    } else return false;
  } catch (error) {
    if (error.code && isHttpErrorCode(error.code)) {
      logger.error(error);
      throw error;
    }
    const userMsg = 'Could not get all position posts';
    logger.error({ userMsg, error });
    throw { code: 500, message: userMsg };
  }
};

/**
 * @function getCompaniesExternal
 * @summary Get a list of all companies from database
 * @param {object} user User information
 * @returns {object} getCompaniesResults
 * @throws {object} errorCodeAndMsg
 */
const getCompaniesExternal = async function getCompaniesExternal(user) {
  try {
    const queryResults = await db.query('select distinct(company) from posts order by company asc', []);
    logger.debug({ label: 'get all companies query response', results: queryResults.rows });

    if (queryResults && queryResults.rows[0]) {
      return queryResults.rows.map((item) => item.company);
    } else return false;
  } catch (error) {
    if (error.code && isHttpErrorCode(error.code)) {
      logger.error(error);
      throw error;
    }
    const userMsg = 'Could not get all companies';
    logger.error({ userMsg, error });
    throw { code: 500, message: userMsg };
  }
};

/**
 * @function getPositionsExternal
 * @summary Get a list of all positions from database
 * @param {object} user User information
 * @returns {object} getPositionsResults
 * @throws {object} errorCodeAndMsg
 */
const getPositionsExternal = async function getPositionsExternal(user) {
  try {
    const queryResults = await db.query('select distinct(position) from posts order by position asc', []);
    logger.debug({ label: 'get all positions query response', results: queryResults.rows });

    if (queryResults && queryResults.rows[0]) {
      return queryResults.rows.map((item) => item.position);
    } else return false;
  } catch (error) {
    if (error.code && isHttpErrorCode(error.code)) {
      logger.error(error);
      throw error;
    }
    const userMsg = 'Could not get all positions';
    logger.error({ userMsg, error });
    throw { code: 500, message: userMsg };
  }
};

module.exports = {
  newPost,
  deletePost,
  getPostExternal,
  modifyPost,
  modifyPostAttachments,
  getAllPostsExternal,
  getAllCompanyPostsExternal,
  getAllPositionPostsExternal,
  getAllPositionCompanyPostsExternal,
  getCompaniesExternal,
  getPositionsExternal,
  verifyPostPin
};
